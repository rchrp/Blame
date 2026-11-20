import assert from "node:assert/strict"
import test from "node:test"

import type { SecurityAudit } from "@blame/agent-runtime"
import type { FollowEvent } from "@blame/engine-client"

import {
  createSecurityAuditRunner,
  type SecurityAuditChange,
} from "./security-audit-runner.ts"

const repository = {
  revision: { snapshotDigest: "digest", dirty: false },
  deterministic: {
    candidates: [],
    inspectedPaths: [],
    limitations: [],
    scanners: [],
  },
  surfaceMap: {
    rootName: "app",
    fileCount: 3,
    relevantFileCount: 2,
    ignoredDirectoryCount: 0,
    truncated: false,
    languages: [],
    frameworks: [],
    projectRoots: [],
    services: [],
    entrypoints: [],
    sensitivePaths: [],
    dependencyPaths: [],
    infrastructurePaths: [],
    ciPaths: [],
    evidencePaths: [],
  },
}
const threatModel = {
  assets: [],
  actors: [],
  trustBoundaries: [],
  attackerInputs: [],
  securityInvariants: [],
}
const finding = {
  id: "SEC-1",
  fingerprint: "f1",
  status: "open",
  title: "Unscoped delete",
} as unknown as SecurityAudit["findings"][number]

type Call = { method: string; input: Record<string, unknown> }

function fakeEngine(options: { stall?: boolean } = {}) {
  const calls: Call[] = []
  const followers = new Map<string, (event: FollowEvent) => void>()
  const follows: string[] = []
  const pending: Array<() => void> = []
  const engine = {
    async call(method: string, input: Record<string, unknown>) {
      calls.push({ method, input })
      if (method === "cancelTask") {
        for (const release of pending.splice(0)) release()
        return true
      }
      if (options.stall)
        await new Promise<void>((resolve) => pending.push(resolve))
      if (method === "discoverSecurityAudit") {
        if (options.stall) throw new Error("was stopped.")
        return {
          session: input.task,
          threatModel,
          candidates: [{ id: "c1" }],
          inspectedPaths: ["src/a.ts"],
          limitations: [],
        }
      }
      return {
        session: input.task,
        threatModel,
        findings: [finding],
        candidateCount: 1,
        rejectedCandidateCount: 0,
        coverage: { percentage: 50 },
      }
    },
    follow(session: string, onEvent: (event: FollowEvent) => void) {
      follows.push(session)
      followers.set(session, onEvent)
      return () => followers.delete(session)
    },
  }
  return { calls, engine: engine as never, followers, follows }
}

test("an audit maps, discovers and validates through engine tasks", async () => {
  const fake = fakeEngine()
  const runner = createSecurityAuditRunner({
    engine: fake.engine,
    map: async () => ({
      workspace: { root: "/projects/app", inVm: true },
      repository,
    }),
  })
  const changes: SecurityAuditChange[] = []
  runner.onChanged((change) => changes.push(change))

  const audit = await runner.run({
    root: "/projects/app",
    projectId: "p",
    model: { providerId: "anthropic", modelId: "m" },
    mode: "standard",
    previousFindings: [{ auditId: "old", fingerprint: "f1", status: "fixed" }],
  })

  assert.equal(audit.status, "completed")
  assert.equal(audit.findings[0]?.status, "regressed")
  assert.equal(audit.findings[0]?.firstSeenAuditId, "old")
  const tasks = fake.calls.map(({ method, input }) => [method, input.task])
  assert.deepEqual(tasks, [
    ["discoverSecurityAudit", `security-${audit.id}-discovery-baseline`],
    ["validateSecurityAudit", `security-${audit.id}-validation`],
  ])
  assert.deepEqual(
    audit.sessionIds,
    tasks.map(([, task]) => task)
  )
  const validate = fake.calls[1]!.input
  assert.deepEqual(validate.workspace, { root: "/projects/app", inVm: true })
  assert.equal(
    (validate.discoveries as unknown[]).length,
    2,
    "the scanners' candidates and the investigator's"
  )
  assert.equal("session" in (validate.discoveries as object[])[1]!, false)
  assert.deepEqual(
    fake.follows,
    tasks.map(([, task]) => task)
  )
  assert.equal(fake.followers.size, 0, "no task followed once it ended")
  assert.ok(changes.every(({ transient }) => !transient))
  assert.equal(runner.active("/projects/app"), undefined)
})

test("a running agent's reads show on its step, and a stop cancels its task", async () => {
  const fake = fakeEngine({ stall: true })
  const runner = createSecurityAuditRunner({
    engine: fake.engine,
    map: async () => ({ workspace: { root: "/app" }, repository }),
  })
  const changes: SecurityAuditChange[] = []
  runner.onChanged((change) => changes.push(change))
  const running = runner.run({
    root: "/app",
    projectId: "p",
    model: { providerId: "anthropic", modelId: "m" },
    mode: "standard",
  })
  while (!fake.followers.size) await new Promise((r) => setTimeout(r, 1))
  const [task, onEvent] = [...fake.followers][0]!
  // Before the engine created the task's session: followed again.
  onEvent({ type: "state", state: "stopped", error: new Error("no session") })
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(fake.follows, [task, task])
  const record = (seq: number, name: string) =>
    ({ seq, type: "tool_call_started", name }) as never
  fake.followers.get(task)!({
    type: "records",
    records: [record(1, "read_code"), record(2, "search_code")],
  })
  fake.followers.get(task)!({
    type: "records",
    records: [record(2, "search_code"), record(3, "read_code")],
  })
  const live = changes.filter(({ transient }) => transient).at(-1)!
  assert.equal(
    live.audit.progress?.steps.find(({ id }) => id === "discovery:baseline")
      ?.detail,
    "2 code reads · 1 search"
  )

  const audit = live.audit
  const stopped = await runner.cancel({ root: "/app", auditId: audit.id })
  assert.equal(stopped?.status, "cancelled")
  assert.deepEqual(
    fake.calls.filter(({ method }) => method === "cancelTask"),
    [{ method: "cancelTask", input: { session: task } }]
  )
  assert.equal((await running).id, audit.id)
  assert.equal(changes.at(-1)?.audit.status, "cancelled")
})
