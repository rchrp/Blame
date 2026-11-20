import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { EngineClient, type EngineClientOptions, type EngineLogLine } from "./client.js"
import {
  EngineClosedError,
  EngineExitedError,
  EngineProtocolVersionError,
  EngineRpcError,
  EngineTimeoutError,
} from "./errors.js"
import type { EngineNotification, SessionRecord } from "./protocol.js"
import { fakeEngine, isAlive, sessionConfig, userText, waitFor } from "./test-support.js"

const base: EngineClientOptions = { clientName: "test", clientVersion: "0.0.0", shutdownTimeoutMs: 1_000 }

const open: EngineClient[] = []
async function start(flags: string[] = [], options: Partial<EngineClientOptions> = {}) {
  const client = await EngineClient.start(fakeEngine({ flags }), { ...base, ...options })
  open.push(client)
  return client
}
afterEach(async () => {
  for (const client of open.splice(0)) client.kill()
  await Promise.all(open.map((client) => client.closed))
})

function records(client: EngineClient): SessionRecord[] {
  const seen: SessionRecord[] = []
  client.onNotification((n) => {
    if (n.method === "session/record") seen.push(n.params.record)
  })
  return seen
}

describe("handshake", () => {
  it("initializes first, reports itself and exposes what the engine said", async () => {
    const client = await start()
    assert.equal(client.info.protocol_version, 1)
    assert.match(client.info.engine_version, /client=test remote_log=false/)
  })

  it("announces remote_log when the four transfer handlers are supplied", async () => {
    const client = await start([], {
      handlers: {
        logPush: () => ({ acked: 0 }),
        logPull: () => ({ records: [], head: 0 }),
        blobPush: () => null,
        blobPull: () => ({}),
      },
    })
    assert.match(client.info.engine_version, /remote_log=true/)
  })

  it("refuses a half-supplied log transfer before starting anything", async () => {
    await assert.rejects(
      EngineClient.start(fakeEngine(), { ...base, handlers: { logPush: () => ({ acked: 0 }) } }),
      /together/,
    )
  })

  it("rejects a protocol version it does not speak and leaves no process behind", async () => {
    const lines: EngineLogLine[] = []
    await assert.rejects(
      EngineClient.start(fakeEngine({ protocolVersion: 99 }), { ...base, onLog: (l) => lines.push(l) }),
      (error: unknown) => {
        assert.ok(error instanceof EngineProtocolVersionError)
        assert.equal(error.actual, 99)
        assert.equal(error.expected, 1)
        return true
      },
    )
  })

  it("reports an engine that cannot be started, with what it wrote to stderr", async () => {
    await assert.rejects(EngineClient.start({ command: "/nonexistent/blame-engine", args: [] }, base), (error: unknown) => {
      assert.ok(error instanceof EngineExitedError)
      assert.match(error.message, /ENOENT/)
      return true
    })
    await assert.rejects(EngineClient.start(fakeEngine({ flags: ["die-on-start"] }), base), (error: unknown) => {
      assert.ok(error instanceof EngineExitedError)
      assert.equal(error.exit.code, 5)
      assert.match(error.message, /cannot start/)
      return true
    })
  })

  it("gives up on an engine that never answers initialize", async () => {
    await assert.rejects(
      EngineClient.start(fakeEngine({ flags: ["silent-start"] }), { ...base, startTimeoutMs: 100 }),
      EngineTimeoutError,
    )
  })

  it("surfaces the engine's stderr as log lines", async () => {
    const lines: EngineLogLine[] = []
    await start(["stderr-banner"], { onLog: (line) => lines.push(line) })
    assert.deepEqual(
      lines.filter((l) => l.source === "engine-stderr").map((l) => l.text),
      ["fake engine starting"],
    )
  })
})

describe("requests", () => {
  it("answers each request with its own result, however they interleave", async () => {
    const client = await start()
    const [a, b] = await Promise.all([
      client.createSession({ session: "a", config: sessionConfig }),
      client.createSession({ session: "b", config: sessionConfig }),
    ])
    assert.equal(a.session, "a")
    assert.equal(b.session, "b")
    const list = await client.listSessions()
    assert.deepEqual(list.sessions.map((s) => s.session).sort(), ["a", "b"])
    const page = await client.readRecords({ session: "a", after: 0, limit: 10 })
    assert.equal(page.records.length, 1)
    assert.equal(page.records[0]!.type, "session_created")
  })

  it("rejects with the engine's error, kind included", async () => {
    const client = await start()
    await assert.rejects(client.openSession({ session: "ghost" }), (error: unknown) => {
      assert.ok(error instanceof EngineRpcError)
      assert.equal(error.code, -32000)
      assert.equal(error.kind, "invalid_request")
      return true
    })
  })

  it("delivers records and deltas as notifications to every listener", async () => {
    const client = await start()
    const first = records(client)
    const deltas: string[] = []
    client.onNotification((n: EngineNotification) => {
      if (n.method === "session/delta" && n.params.delta.type === "text") deltas.push(n.params.delta.text)
    })
    client.onNotification(() => {
      throw new Error("a broken listener")
    })
    await client.createSession({ session: "s", config: sessionConfig })
    await client.subscribe({ session: "s", after: 0 })
    await client.sendMessage({ session: "s", input: userText("hi"), delivery: "turn" })
    await waitFor(() => first.some((r) => r.type === "turn_ended"), "the turn to end")
    assert.deepEqual(deltas, ["Hel", "lo"])
    assert.deepEqual(
      first.map((r) => r.seq),
      [1, 2, 3, 4, 5],
    )
  })

  it("cancels a pending request: $/cancel goes to the engine and the caller is released at once", async () => {
    const lines: EngineLogLine[] = []
    const client = await start([], { onLog: (l) => lines.push(l) })
    await client.createSession({ session: "s", config: sessionConfig })
    const controller = new AbortController()
    const request = client.sendMessage({ session: "s", input: userText("slow"), delivery: "turn" }, { signal: controller.signal })
    const settled = assert.rejects(request, /stop it/)
    controller.abort(new Error("stop it"))
    await settled
    await waitFor(() => lines.some((l) => /cancelled request/.test(l.text)), "the engine to see the cancel")
    // The engine answers late; that must not disturb anything.
    assert.equal((await client.listSessions()).sessions.length, 1)
  })

  it("does not send a request whose signal is already aborted", async () => {
    const client = await start()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(client.listSessions({ signal: controller.signal }), { name: "AbortError" })
  })

  it("times out a request and cancels it", async () => {
    const client = await start()
    await client.createSession({ session: "s", config: sessionConfig })
    await assert.rejects(
      client.sendMessage({ session: "s", input: userText("slow"), delivery: "turn" }, { timeoutMs: 50 }),
      EngineTimeoutError,
    )
  })

  it("survives output that is not protocol", async () => {
    const lines: EngineLogLine[] = []
    const client = await start(["noisy"], { onLog: (l) => lines.push(l) })
    assert.equal((await client.listSessions()).sessions.length, 0)
    assert.ok(lines.some((l) => l.source === "client" && /not JSON/.test(l.text)))
    assert.ok(lines.some((l) => l.source === "client" && /some\/unknown/.test(l.text)))
  })
})

describe("requests from the engine", () => {
  async function runTool(word: string, handlers: EngineClientOptions["handlers"]) {
    const client = await start([], { handlers })
    const seen = records(client)
    await client.createSession({ session: "s", config: sessionConfig })
    await client.subscribe({ session: "s", after: 0 })
    await client.sendMessage({ session: "s", input: userText(word), delivery: "turn" })
    await waitFor(() => seen.some((r) => r.type === "turn_ended"), "the turn to end")
    return seen
  }

  it("runs the caller's tools, in parallel, and returns each result", async () => {
    const running = new Set<string>()
    let peak = 0
    const seen = await runTool("tools", {
      tool: async ({ name }) => {
        running.add(name)
        peak = Math.max(peak, running.size)
        await new Promise((resolve) => setTimeout(resolve, 40))
        running.delete(name)
        return { outcome: "completed", content: [{ type: "text", text: `ran ${name}` }] }
      },
    })
    assert.equal(peak, 2)
    const finished = seen.filter((r) => r.type === "tool_call_finished")
    assert.deepEqual(
      finished.map((r) => r.type === "tool_call_finished" && r.content),
      [[{ type: "text", text: "ran read_a" }], [{ type: "text", text: "ran read_b" }]],
    )
  })

  it("asks the user's approval and carries the decision back", async () => {
    const seen = await runTool("approval", {
      approval: () => ({ decision: "denied" }),
      tool: () => ({ outcome: "completed", content: [] }),
    })
    const resolved = seen.find((r) => r.type === "approval_resolved")
    assert.equal(resolved?.type === "approval_resolved" && resolved.decision, "denied")
    const finished = seen.find((r) => r.type === "tool_call_finished")
    assert.equal(finished?.type === "tool_call_finished" && finished.outcome, "denied")
  })

  it("serves credentials and log transfer", async () => {
    const pushed: number[] = []
    const seen = await runTool("logpush", {
      credential: () => ({ type: "missing" }),
      logPush: ({ records: batch }) => {
        pushed.push(batch.length)
        return { acked: batch.length }
      },
      logPull: () => ({ records: [], head: 0 }),
      blobPush: () => null,
      blobPull: () => ({}),
    })
    assert.ok(pushed.length === 1 && pushed[0]! >= 3)
    const notice = seen.find((r) => r.type === "notice")
    assert.equal(notice?.type === "notice" && notice.code, "acked")
  })

  it("answers an error when no handler exists or the handler throws", async () => {
    const missing = await runTool("tool", {})
    const failedMissing = missing.find((r) => r.type === "tool_call_finished")
    assert.equal(failedMissing?.type === "tool_call_finished" && failedMissing.outcome, "failed")
    assert.match(JSON.stringify(failedMissing), /does not handle host\/tool/)

    const thrown = await runTool("tool", {
      tool: () => {
        throw new Error("the tool broke")
      },
    })
    assert.match(JSON.stringify(thrown.find((r) => r.type === "tool_call_finished")), /the tool broke/)
  })

  it("aborts a handler's signal when the engine withdraws its request, and does not answer", async () => {
    let aborted = false
    const seen = await runTool("cancel", {
      tool: ({ name }, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error(`${name} stopped`))
          })
        }),
    })
    assert.equal(aborted, true)
    // The engine moved on without our answer (it records its own outcome).
    const finished = seen.find((r) => r.type === "tool_call_finished")
    assert.equal(finished?.type === "tool_call_finished" && finished.outcome, "cancelled")
  })
})

describe("the engine ends", () => {
  it("rejects what is pending when the engine crashes mid-request, and says why", async () => {
    const exits: number[] = []
    const client = await start([], { onExit: () => exits.push(1) })
    await client.createSession({ session: "s", config: sessionConfig })
    await assert.rejects(
      client.sendMessage({ session: "s", input: userText("crash"), delivery: "turn" }),
      (error: unknown) => {
        assert.ok(error instanceof EngineExitedError)
        assert.equal(error.exit.code, 3)
        assert.equal(error.exit.expected, false)
        assert.match(error.message, /simulated crash/)
        return true
      },
    )
    const exit = await client.closed
    assert.equal(exit.expected, false)
    assert.ok(client.isClosed)
    await assert.rejects(client.listSessions(), EngineExitedError)
    assert.equal(exits.length, 1)
  })

  it("reports an engine that exits on its own, and rejects every pending request at once", async () => {
    const client = await start(["exit-after-start"])
    await client.createSession({ session: "s", config: sessionConfig }).catch(() => {})
    const exit = await client.closed
    assert.equal(exit.code, 4)
    assert.equal(exit.expected, false)
  })

  it("shuts down gracefully: shutdown request, then exit, no kill", async () => {
    const client = await start()
    const exit = await client.shutdown()
    assert.equal(exit.expected, true)
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    assert.equal((await client.shutdown()).code, 0)
    await assert.rejects(client.listSessions(), EngineClosedError)
  })

  it("kills an engine that ignores the shutdown request, after the timeout", async () => {
    const client = await start(["ignore-shutdown"])
    const started = Date.now()
    const exit = await client.shutdown(200)
    assert.equal(exit.expected, true)
    assert.equal(exit.signal, "SIGTERM")
    assert.ok(Date.now() - started < 3_000)
  })

  it("escalates to SIGKILL when the engine also ignores SIGTERM", async () => {
    const client = await start(["ignore-shutdown", "ignore-sigterm"])
    const exit = await client.shutdown(100)
    assert.equal(exit.signal, "SIGKILL")
  })

  it("kill() ends the engine at once", async () => {
    const client = await start(["announce-pid"], { onLog: () => {} })
    client.kill()
    const exit = await client.closed
    assert.equal(exit.signal, "SIGKILL")
  })
})

describe("no process outlives its client", () => {
  async function engineAndParent(parentScript: string, flags: string[] = []) {
    const { spawn } = await import("node:child_process")
    const { fileURLToPath } = await import("node:url")
    const script = fileURLToPath(new URL(`../test/${parentScript}`, import.meta.url))
    const parent = spawn(process.execPath, [script], {
      env: { ...process.env, FAKE_FLAGS: ["announce-pid", ...flags].join(",") },
      stdio: ["pipe", "pipe", "inherit"],
    })
    const pid = await new Promise<number>((resolve, reject) => {
      parent.stdout.setEncoding("utf8")
      parent.stdout.on("data", (chunk: string) => {
        const match = /pid:(\d+)/.exec(chunk)
        if (match) resolve(Number(match[1]))
      })
      parent.once("error", reject)
    })
    return { parent, pid }
  }

  it("ends the engine when the parent is killed (its stdin closes)", async () => {
    const { parent, pid } = await engineAndParent("orphan-parent.mjs")
    assert.ok(isAlive(pid))
    parent.kill("SIGKILL")
    await waitFor(() => !isAlive(pid), "the engine to end after its parent was killed")
  })

  it("kills the engine when the parent exits without shutting it down", async () => {
    const { parent, pid } = await engineAndParent("orphan-parent.mjs", ["ignore-shutdown"])
    assert.ok(isAlive(pid))
    parent.stdin?.end()
    await waitFor(() => !isAlive(pid), "the engine to be killed by the exit hook")
  })
})
