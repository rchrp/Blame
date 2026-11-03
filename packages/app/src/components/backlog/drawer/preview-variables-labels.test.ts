import assert from "node:assert/strict"
import test from "node:test"
import type {
  PreviewEnvironmentView,
  PreviewVariableView,
} from "@blame/agent-runtime"
import {
  changedServices,
  databaseModeSummary,
  variableNeedsValue,
  variableSourceLabel,
  variableStatusLabel,
} from "./preview-variables-labels.ts"

function variable(input: Partial<PreviewVariableView>): PreviewVariableView {
  return {
    key: "KEY",
    value: "value",
    masked: false,
    source: "env-file",
    locked: false,
    status: "set",
    ...input,
  }
}

test("names where a value comes from", () => {
  assert.equal(
    variableSourceLabel(variable({ file: "apps/api/.env.local" })),
    "from .env.local"
  )
  assert.equal(
    variableSourceLabel(variable({ source: "blame-database", locked: true })),
    "Blame: isolated database"
  )
  assert.equal(
    variableSourceLabel(variable({ source: "story" })),
    "story override"
  )
  assert.equal(
    variableSourceLabel(
      variable({ source: "env-example", file: "packages/api/start/env.ts" })
    ),
    "declared in start/env.ts"
  )
  assert.equal(
    variableSourceLabel(variable({ source: "manifest" })),
    "setup default"
  )
})

test("asks a person only for keys they can fill in", () => {
  assert.equal(variableNeedsValue(variable({ status: "missing" })), true)
  assert.equal(variableNeedsValue(variable({ status: "placeholder" })), true)
  assert.equal(
    variableNeedsValue(variable({ status: "missing", locked: true })),
    false
  )
  assert.equal(variableNeedsValue(variable({ status: "empty" })), false)
  assert.equal(
    variableNeedsValue(variable({ status: "empty", required: true })),
    true
  )
  assert.equal(variableStatusLabel(variable({ status: "removed" })), "left out")
  assert.equal(variableStatusLabel(variable({})), undefined)
})

test("sums up the database mode and the services to restart", () => {
  const view: PreviewEnvironmentView = {
    databaseMode: "existing",
    services: [
      {
        id: "api",
        kind: "service",
        directory: ".",
        changedSinceStart: true,
        variables: [variable({ key: "DATABASE_URL", file: ".env" })],
      },
      {
        id: "migrate",
        kind: "setup",
        directory: ".",
        changedSinceStart: true,
        variables: [],
      },
    ],
    warnings: [],
    requests: [],
    encrypted: true,
  }
  assert.equal(
    databaseModeSummary(view).title,
    "Your database: DATABASE_URL from .env"
  )
  assert.equal(
    databaseModeSummary({ ...view, databaseMode: "compose" }).title,
    "Isolated database (Blame)"
  )
  assert.deepEqual(changedServices(view), ["api"])
})
