import assert from "node:assert/strict"
import test from "node:test"

import {
  externalProjectApp,
  localPreviewPort,
  projectAppAnswer,
} from "./project-app-port.ts"

const busy = (owner: "project" | "other" | "unknown", cwd?: string) => ({
  status: "busy" as const,
  owner,
  ...(cwd ? { cwd } : {}),
  processName: "node",
})

test("finds the local port of a preview address", () => {
  assert.equal(localPreviewPort("http://localhost:3000/"), 3000)
  assert.equal(localPreviewPort("127.0.0.1:5173"), 5173)
  assert.equal(localPreviewPort("https://staging.example.com"), undefined)
  assert.equal(localPreviewPort(undefined), undefined)
})

test("an unknown holder follows the person's answer", () => {
  assert.deepEqual(externalProjectApp(undefined, undefined), { kind: "none" })
  assert.deepEqual(externalProjectApp({ status: "free" }, true), {
    kind: "none",
  })
  assert.equal(
    externalProjectApp(busy("project", "/p"), undefined).kind,
    "project"
  )
  assert.equal(externalProjectApp(busy("other", "/q"), true).kind, "other")
  assert.equal(externalProjectApp(busy("unknown"), undefined).kind, "unknown")
  assert.deepEqual(externalProjectApp(busy("unknown"), true), {
    kind: "project",
    confirmed: true,
    owner: busy("unknown"),
  })
  assert.equal(externalProjectApp(busy("unknown"), false).kind, "other")
})

const configuration = {
  id: "web",
  name: "Web app",
  command: "pnpm dev",
  cwd: ".",
  default: true,
  category: "web" as const,
  services: [],
  scopes: [],
  previewUrl: "http://localhost:3000",
}

function runner(
  overrides: Partial<Parameters<typeof projectAppAnswer>[0]> = {}
) {
  const started: string[] = []
  return {
    started,
    value: {
      external: { kind: "none" as const },
      previewConfiguration: configuration,
      projectPath: "/Users/raph/site-a",
      sessionFor: () => undefined,
      start: (id: string) => started.push(id),
      terminal: {} as never,
      ...overrides,
    } as Parameters<typeof projectAppAnswer>[0],
  }
}

test("the agent starts a stopped app through the shared runner", () => {
  const stopped = runner()
  assert.equal(projectAppAnswer(stopped.value, "status").status, "stopped")
  assert.deepEqual(stopped.started, [])
  const answer = projectAppAnswer(stopped.value, "start")
  assert.equal(answer.status, "starting")
  assert.equal(answer.previewUrl, "http://localhost:3000")
  assert.deepEqual(stopped.started, ["web"])
})

test("an app already running is reported, never started twice", () => {
  const blame = runner({
    sessionFor: () => ({
      configurationId: "web",
      logs: "ready",
      name: "Web app",
      status: "running",
    }),
  })
  assert.equal(projectAppAnswer(blame.value, "start").status, "running")
  assert.deepEqual(blame.started, [])

  const outside = runner({
    external: {
      kind: "project",
      confirmed: false,
      owner: busy("project", "/Users/raph/site-a"),
    },
  })
  const answer = projectAppAnswer(outside.value, "start")
  assert.equal(answer.status, "running")
  assert.equal(answer.runningOutsideBlame, true)
  assert.deepEqual(outside.started, [])
})

test("a port held by another app is a conflict to report", () => {
  const other = runner({
    external: { kind: "other", owner: busy("other", "/Users/raph/site-b") },
  })
  const answer = projectAppAnswer(other.value, "start")
  assert.equal(answer.status, "conflict")
  assert.deepEqual(answer.owner, {
    kind: "other",
    folder: "/Users/raph/site-b",
    process: "node",
  })
  assert.deepEqual(other.started, [])
  const unknown = runner({
    external: { kind: "unknown", owner: busy("unknown") },
  })
  assert.equal(projectAppAnswer(unknown.value, "start").owner?.kind, "unknown")
})

test("without a preview configuration there is no app to run", () => {
  assert.equal(
    projectAppAnswer(runner({ previewConfiguration: undefined }).value, "start")
      .status,
    "unavailable"
  )
})
