import assert from "node:assert/strict"
import test from "node:test"

import {
  appWindowRole,
  loadedWindowRole,
  windowAwaitsReplacement,
  type AppWindowRoleInput,
} from "./app-window-role.ts"

const workspaceInput: AppWindowRoleInput = {
  activeProject: { id: "project" },
  aiPreferences: {},
  authStatus: "authenticated",
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

test("holds a compact window back while the workspace window replaces it", () => {
  const loaded = loadedWindowRole("?window-role=compact&route=%2Fbacklog")
  assert.equal(loaded, "compact")
  assert.equal(windowAwaitsReplacement(loaded, "workspace"), true)
  assert.equal(windowAwaitsReplacement(loaded, "compact"), false)
})

test("never holds back a workspace window or a window outside the desktop", () => {
  assert.equal(windowAwaitsReplacement("workspace", "workspace"), false)
  assert.equal(windowAwaitsReplacement("workspace", "compact"), false)
  assert.equal(
    windowAwaitsReplacement(loadedWindowRole(""), "workspace"),
    false
  )
})
