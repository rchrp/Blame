// A stand-in for `blame-engine serve`: speaks the same JSON-RPC lines over
// stdio, with just enough behaviour to exercise the client. The real binary
// is tested separately (src/real-engine.test.ts).
//
// Configuration, all through the environment so a test can restart it:
//   FAKE_STORE             JSON file keeping sessions across restarts
//   FAKE_PROTOCOL_VERSION  protocol version to announce (default 1)
//   FAKE_FLAGS             comma list of: die-on-start (exit before answering
//                          initialize), exit-after-start, silent-start,
//                          ignore-shutdown (survives shutdown and stdin EOF),
//                          ignore-sigterm, backlog-after, duplicate-backlog,
//                          noisy, stderr-banner, announce-pid
//
// A `session/send` whose first text block starts with one of these words
// drives a scenario: crash, slow, tool, tools, approval, credential, cancel,
// logpush, fail, steer. Anything else gets a plain streamed answer.

import { readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const flags = new Set((process.env.FAKE_FLAGS ?? "").split(",").filter(Boolean))
const storePath = process.env.FAKE_STORE
const protocolVersion = Number(process.env.FAKE_PROTOCOL_VERSION ?? 1)

const sessions = new Map() // id -> { config, records }
const subscribed = new Set()
const cancelable = new Map() // request id -> () => void
const hostPending = new Map() // engine request id -> { resolve, reject }
let nextHostId = 1000
let nextSession = 1
let nextTurn = 1
let nextCall = 1
let nextRequest = 1

if (storePath) {
  try {
    const stored = JSON.parse(readFileSync(storePath, "utf8"))
    for (const [id, session] of Object.entries(stored.sessions)) sessions.set(id, session)
    nextSession = stored.nextSession
    nextTurn = stored.nextTurn
    nextCall = stored.nextCall
    nextRequest = stored.nextRequest
  } catch {
    // First start: nothing stored yet.
  }
}

function persist() {
  if (!storePath) return
  writeFileSync(
    storePath,
    JSON.stringify({
      sessions: Object.fromEntries(sessions),
      nextSession,
      nextTurn,
      nextCall,
      nextRequest,
    }),
  )
}

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
}

const reply = (id, result) => write({ id, result })
const fail = (id, message, kind = "invalid_request", code = -32000) =>
  write({ id, error: { code, message, data: { kind } } })

function notifyRecord(session, record) {
  if (!subscribed.has(session)) return
  write({ method: "session/record", params: { session, record } })
  if (flags.has("duplicate-backlog")) write({ method: "session/record", params: { session, record } })
}

function append(session, body) {
  const log = sessions.get(session)
  const record = { seq: log.records.length + 1, at_ms: Date.now(), ...body }
  log.records.push(record)
  persist()
  notifyRecord(session, record)
  return record
}

function delta(session, value) {
  if (subscribed.has(session)) write({ method: "session/delta", params: { session, delta: value } })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hostRequest(method, params) {
  const id = nextHostId++
  write({ id, method, params })
  const promise = new Promise((resolve, reject) => hostPending.set(id, { resolve, reject }))
  return { id, promise }
}

const modelRef = { provider: "fake", model: "fake-1" }
const noUsage = { input_tokens: 10, output_tokens: 5, cost_micro_usd: 100 }

function textOf(input) {
  return input.find((block) => block.type === "text")?.text ?? ""
}

async function runTurn(session, turn, text) {
  const request = `req-${nextRequest++}`
  const [word, ...rest] = text.split(" ")
  const requestStarted = (attempt = 1) =>
    append(session, {
      type: "request_started",
      turn,
      request,
      model: modelRef,
      attempt,
      prefix_digest: "sha256:0",
    })

  if (word === "fail") {
    requestStarted()
    append(session, {
      type: "request_failed",
      turn,
      request,
      error: { kind: "overloaded", message: "try later", retry_after_ms: 10 },
    })
    await sleep(5)
    requestStarted(2)
  } else {
    requestStarted()
  }

  if (word === "tool" || word === "tools" || word === "approval" || word === "cancel") {
    const names = word === "tools" ? ["read_a", "read_b"] : [rest[0] ?? "client_tool"]
    const calls = names.map((name) => ({ call: `call-${nextCall++}`, name }))
    append(session, {
      type: "assistant_message",
      turn,
      request,
      blocks: calls.map(({ call, name }) => ({ type: "tool_call", call, name, input: { n: name } })),
      stop: "tool_use",
      usage: noUsage,
    })
    await Promise.all(
      calls.map(async ({ call, name }) => {
        if (word === "approval") {
          append(session, { type: "approval_requested", turn, call })
          const { promise } = hostRequest("host/approval", {
            session,
            turn,
            call,
            tool: { name, description: "", input_schema: {}, effect: "command", ends_turn: false, needs_approval: true },
            input: { n: name },
          })
          const { decision } = await promise
          append(session, { type: "approval_resolved", turn, call, decision })
          if (decision === "denied") {
            append(session, {
              type: "tool_call_finished",
              turn,
              call,
              outcome: "denied",
              content: [{ type: "text", text: "denied" }],
            })
            return
          }
        }
        append(session, { type: "tool_call_started", turn, call, name, effect: "read_only" })
        const { id, promise } = hostRequest("host/tool", { session, turn, call, name, input: { n: name } })
        if (word === "cancel") setTimeout(() => write({ method: "$/cancel", params: { id } }), 30)
        const outcome = await Promise.race([
          promise.catch((error) => ({ outcome: "failed", content: [{ type: "text", text: error.message }] })),
          sleep(300).then(() => ({ outcome: "cancelled", content: [] })),
        ])
        append(session, { type: "tool_call_finished", turn, call, outcome: outcome.outcome, content: outcome.content })
      }),
    )
    const next = `req-${nextRequest++}`
    append(session, { type: "request_started", turn, request: next, model: modelRef, attempt: 1, prefix_digest: "sha256:1" })
    append(session, {
      type: "assistant_message",
      turn,
      request: next,
      blocks: [{ type: "text", text: "done" }],
      stop: "end_turn",
      usage: noUsage,
    })
  } else {
    if (word === "credential") {
      const { promise } = hostRequest("host/credential", { provider: "fake" })
      const credential = await promise
      append(session, { type: "notice", level: "info", code: "credential", text: credential.type })
    }
    if (word === "logpush") {
      const { promise } = hostRequest("host/log/push", { session, records: sessions.get(session).records })
      const { acked } = await promise
      append(session, { type: "notice", level: "info", code: "acked", text: String(acked) })
    }
    for (const part of ["Hel", "lo"]) {
      delta(session, { type: "text", request, index: 0, text: part })
      await sleep(5)
    }
    append(session, {
      type: "assistant_message",
      turn,
      request,
      blocks: [{ type: "text", text: `echo: ${text}` }],
      stop: "end_turn",
      usage: noUsage,
    })
  }
  append(session, { type: "turn_ended", turn, outcome: { status: "completed" } })
}

const handlers = {
  initialize(id, params) {
    if (flags.has("silent-start")) return
    if (flags.has("stderr-banner")) process.stderr.write("fake engine starting\n")
    if (flags.has("announce-pid")) process.stderr.write(`pid:${process.pid}\n`)
    if (flags.has("die-on-start")) {
      process.stderr.write("fake engine: cannot start\n")
      process.exit(5)
    }
    // The announced version carries what the client said, for the tests.
    reply(id, {
      protocol_version: protocolVersion,
      engine_version: `fake-0.0.1 client=${params.client_name} remote_log=${params.remote_log}`,
    })
    if (flags.has("exit-after-start")) setTimeout(() => process.exit(4), 20)
  },

  "session/create"(id, params) {
    const session = params.session ?? `session-${nextSession++}`
    sessions.set(session, { config: params.config, records: [] })
    append(session, { type: "session_created", config: params.config })
    reply(id, { session, head: 1, activity: { state: "idle" } })
  },

  "session/open"(id, { session }) {
    const log = sessions.get(session)
    if (!log) return fail(id, `no such session ${session}`)
    reply(id, { session, head: log.records.length, activity: { state: "idle" } })
  },

  "session/list"(id) {
    reply(id, {
      sessions: [...sessions].map(([session, log]) => ({
        session,
        purpose: log.config.purpose,
        workspace_root: log.config.workspace_root,
        head: log.records.length,
        updated_at_ms: 0,
      })),
    })
  },

  "session/read"(id, { session, after, limit }) {
    const log = sessions.get(session)
    if (!log) return fail(id, `no such session ${session}`)
    reply(id, { records: log.records.filter((r) => r.seq > after).slice(0, limit), head: log.records.length })
  },

  "session/subscribe"(id, { session, after }) {
    const log = sessions.get(session)
    if (!log) return fail(id, `no such session ${session}`)
    const backlog = log.records.filter((record) => record.seq > after)
    const sendBacklog = () => {
      subscribed.add(session)
      for (const record of backlog) {
        write({ method: "session/record", params: { session, record } })
        if (flags.has("duplicate-backlog")) write({ method: "session/record", params: { session, record } })
      }
    }
    const result = { head: log.records.length, activity: { state: "idle" }, in_flight: [] }
    if (flags.has("backlog-after")) {
      subscribed.add(session)
      reply(id, result)
      sendBacklog()
    } else {
      sendBacklog()
      reply(id, result)
    }
  },

  "session/unsubscribe"(id, { session }) {
    subscribed.delete(session)
    reply(id, null)
  },

  "session/send"(id, { session, input, delivery }) {
    const log = sessions.get(session)
    if (!log) return fail(id, `no such session ${session}`)
    const text = textOf(input)
    if (delivery === "steer") {
      const open = [...log.records].reverse().find((r) => r.type === "user_message" && r.delivery === "turn")
      append(session, { type: "user_message", turn: open.turn, input, delivery })
      return reply(id, { turn: open.turn, started: false })
    }
    const turn = `turn-${nextTurn++}`
    append(session, { type: "user_message", turn, input, delivery })
    if (text === "crash") {
      process.stderr.write("fake engine: simulated crash\n")
      process.exit(3)
    }
    if (text === "slow") {
      // Answered only when the client withdraws the request.
      cancelable.set(id, () => fail(id, "cancelled", "cancelled"))
      return
    }
    reply(id, { turn, started: true })
    runTurn(session, turn, text).catch((error) => process.stderr.write(`fake engine: ${error.stack}\n`))
  },

  "session/interrupt"(id) {
    reply(id, null)
  },

  "session/rewind"(id, { session, to }) {
    const log = sessions.get(session)
    const started = append(session, { type: "rewind_started", to })
    const finished = append(session, {
      type: "rewind_finished",
      started: started.seq,
      to,
      workspace: { status: "not_requested" },
      unreverted_commands: [],
    })
    void log
    reply(id, { finished: finished.seq })
  },

  "session/undo_rewind"(id, { session }) {
    const log = sessions.get(session)
    const finished = [...log.records].reverse().find((r) => r.type === "rewind_finished")
    append(session, { type: "rewind_undone", rewind: finished.seq })
    reply(id, null)
  },

  shutdown(id) {
    reply(id, null)
    if (flags.has("ignore-shutdown")) return
    process.exit(0)
  },
}

if (flags.has("ignore-sigterm")) process.on("SIGTERM", () => {})

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  if (flags.has("noisy")) {
    write({ method: "some/unknown" })
    process.stdout.write("this line is not json\n")
  }
  const message = JSON.parse(line)
  if (message.method === "$/cancel") {
    process.stderr.write(`cancelled request ${message.params.id}\n`)
    cancelable.get(message.params.id)?.()
    cancelable.delete(message.params.id)
    return
  }
  if (message.method === undefined) {
    // A response to one of our requests.
    const waiting = hostPending.get(message.id)
    hostPending.delete(message.id)
    if (message.error) waiting?.reject(new Error(message.error.message))
    else waiting?.resolve(message.result)
    return
  }
  const handler = handlers[message.method]
  if (!handler) return fail(message.id, `unknown method ${message.method}`, "invalid_request", -32601)
  handler(message.id, message.params)
})

lines.on("close", () => {
  // The client went away (or was killed): an engine with nobody to serve ends.
  if (flags.has("ignore-shutdown")) return setInterval(() => {}, 1000)
  process.exit(0)
})
