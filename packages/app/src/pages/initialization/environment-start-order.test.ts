import assert from "node:assert/strict"
import test from "node:test"

import { startOrder } from "./environment-start-order.ts"
import type { SavedSetup } from "./initialization-setup-draft.ts"

type Manifest = SavedSetup["previewManifest"]

function setup(
  services: Partial<Manifest["services"][number]>[],
  tasks: Partial<Manifest["setup"][number]>[] = [],
  started: string[] = []
): SavedSetup {
  return {
    previewManifest: {
      confidence: "high",
      project: { root: ".", detectedStack: ["node"], confidence: "high" },
      setup: tasks.map((task) => ({
        container: { image: "node:22" },
        workingDir: "/workspace",
        command: "true",
        ...task,
      })),
      services: services.map((service) => ({
        kind: "dependency",
        container: { image: "postgres:16" },
        endpoints: [],
        ...service,
      })),
      caches: [],
      risks: [],
      probes: [],
    } as unknown as Manifest,
    runConfigurations: [
      {
        id: "web",
        name: "Web",
        command: "npm run dev",
        cwd: ".",
        default: true,
        category: "web",
        services: started,
        scopes: ["web"],
      },
    ] as SavedSetup["runConfigurations"],
  }
}

const ids = (steps: ReturnType<typeof startOrder>) =>
  steps.map((step) => step.map(({ id }) => id))

test("starts what setup waits for, then the setup, then the rest", () => {
  const steps = startOrder(
    setup(
      [
        { id: "db" },
        {
          id: "web",
          kind: "preview",
          dependsOn: ["db"],
          endpoints: [{ id: "http", protocol: "http", port: 3000 }],
        },
      ],
      [{ id: "deps" }, { id: "migrate", dependsOn: ["db", "deps"] }],
      ["web"]
    )
  )
  assert.deepEqual(ids(steps), [["db"], ["deps"], ["migrate"], ["web"]])
  assert.deepEqual(steps[3]![0], {
    type: "service",
    id: "web",
    kind: "preview",
    port: 3000,
  })
})

test("groups containers that start together", () => {
  const steps = startOrder(
    setup([
      { id: "db" },
      { id: "cache" },
      { id: "web", kind: "preview", dependsOn: ["db", "cache"] },
    ])
  )
  assert.deepEqual(ids(steps), [["db", "cache"], ["web"]])
})

test("leaves out services the default configuration does not start", () => {
  const steps = startOrder(
    setup(
      [
        { id: "db" },
        { id: "mail" },
        {
          id: "web",
          kind: "preview",
          bindings: [
            {
              target: { key: "DATABASE_URL" },
              source: { service: "db", endpoint: "sql" },
              exposure: "server",
            },
          ] as Manifest["services"][number]["bindings"],
        },
      ],
      [],
      ["web"]
    )
  )
  assert.deepEqual(ids(steps), [["db"], ["web"]])
})

test("a dependency cycle ends instead of looping", () => {
  const steps = startOrder(
    setup([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ])
  )
  assert.deepEqual(ids(steps), [["a", "b"]])
})
