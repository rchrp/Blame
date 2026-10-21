import assert from "node:assert/strict"
import test from "node:test"

import { appWindowRole, type AppWindowRoleInput } from "./app-window-role.ts"

const workspaceInput: AppWindowRoleInput = {
  activeProject: { id: "project" },
  aiPreferences: {},
  authStatus: "authenticated",
  premiumOpen: false,
  statusPipOpen: false,
}

test("does not manage auxiliary or loading window roles", () => {
  assert.equal(
    appWindowRole({ ...workspaceInput, statusPipOpen: true }),
    undefined
  )
  assert.equal(
    appWindowRole({ ...workspaceInput, authStatus: "loading" }),
    undefined
  )
})

test("uses compact windows for every screen outside the application layout", () => {
  const compactInputs: AppWindowRoleInput[] = [
    { ...workspaceInput, authStatus: "unauthenticated" },
    { ...workspaceInput, premiumOpen: true },
    { ...workspaceInput, aiPreferences: null },
    { ...workspaceInput, activeProject: undefined },
  ]

  for (const input of compactInputs) {
    assert.equal(appWindowRole(input), "compact")
  }
})

test("uses the workspace window only for the application layout", () => {
  assert.equal(appWindowRole(workspaceInput), "workspace")
})
