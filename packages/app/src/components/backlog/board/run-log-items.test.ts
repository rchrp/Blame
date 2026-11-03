import assert from "node:assert/strict"
import test from "node:test"

import type { ProjectRunConfiguration } from "@blame/agent-runtime"

import {
  previewServiceStatuses,
  projectRunLogItems,
  runLogItemStopped,
  sortRunLogItems,
} from "./run-log-items.ts"

const configuration = (
  id: string,
  services: string[],
  extra: Partial<ProjectRunConfiguration> = {}
): ProjectRunConfiguration => ({
  category: "web",
  command: "",
  cwd: ".",
  default: false,
  id,
  name: id,
  scopes: [],
  services,
  ...extra,
})

test("puts running items first and keeps each group's order", () => {
  const sorted = sortRunLogItems([
    { id: "web", label: "web", status: "stopped" },
    { id: "api", label: "api", status: "error" },
    { id: "desktop", label: "desktop" },
    { id: "vitrine", label: "vitrine", status: "running" },
    { id: "docs", label: "docs", status: "starting" },
    { id: "admin", label: "admin", status: "running" },
  ])
  assert.deepEqual(
    sorted.map(({ id }) => id),
    ["vitrine", "admin", "docs", "api", "web", "desktop"]
  )
})

test("only a known stopped status counts as not started", () => {
  assert.equal(
    runLogItemStopped({ id: "a", label: "a", status: "stopped" }),
    true
  )
  assert.equal(runLogItemStopped({ id: "a", label: "a" }), false)
  assert.equal(runLogItemStopped(undefined), false)
})

test("gives each service the status of the configuration that runs it", () => {
  const statuses = previewServiceStatuses(
    {
      configurations: [
        configuration("site", ["vitrine"]),
        configuration("app", ["web"]),
      ],
      statuses: { site: "running", app: "stopped" },
    },
    ["web", "api", "desktop", "vitrine"]
  )
  assert.deepEqual(statuses, {
    api: "stopped",
    desktop: "stopped",
    vitrine: "running",
    web: "stopped",
  })
})

test("counts the services a configuration depends on as running too", () => {
  const statuses = previewServiceStatuses(
    {
      configurations: [configuration("app", ["web"])],
      statuses: { app: "starting" },
    },
    ["web", "api", "db"],
    {
      services: [
        { id: "web", dependsOn: ["api"] },
        { id: "api", bindings: [{ source: { service: "db" } }] },
        { id: "db" },
      ] as never,
    }
  )
  assert.deepEqual(statuses, {
    api: "starting",
    db: "starting",
    web: "starting",
  })
})

test("keeps the best status of a service shared by two configurations", () => {
  const statuses = previewServiceStatuses(
    {
      configurations: [
        configuration("broken", ["api"]),
        configuration("app", ["web", "api"]),
      ],
      statuses: { broken: "error", app: "running" },
    },
    ["web", "api"]
  )
  assert.equal(statuses?.api, "running")
})

test("knows no service status before the configurations load", () => {
  assert.equal(previewServiceStatuses(undefined, ["web"]), undefined)
})

test("lists every app and the tasks run beside them, running first", () => {
  const items = projectRunLogItems(
    [configuration("web", []), configuration("site", [])],
    [
      { configurationId: "site", name: "site", status: "running" },
      { configurationId: "install", name: "Install", status: "error" },
    ],
    (id) => (id === "site" ? "running" : "stopped")
  )
  assert.deepEqual(
    items.map(({ id, status }) => [id, status]),
    [
      ["site", "running"],
      ["install", "error"],
      ["web", "stopped"],
    ]
  )
})
