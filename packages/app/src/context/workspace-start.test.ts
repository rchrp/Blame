import assert from "node:assert/strict"
import test from "node:test"

import {
  initialWorkspace,
  readWorkspaceStart,
  signInTitle,
  writeWorkspaceStart,
} from "./workspace-start.ts"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test("shows the sign-in screen on first launch", () => {
  const storage = memoryStorage()
  const start = initialWorkspace({
    localAvailable: true,
    start: readWorkspaceStart(storage),
  })
  assert.deepEqual(start, { open: "sign-in", greeting: "first-launch" })
  assert.equal(
    signInTitle({ greeting: "first-launch", fromLocalWorkspace: false }).title,
    "Welcome to Blame"
  )
})

test("opens the local workspace once someone continued without an account", () => {
  const storage = memoryStorage()
  writeWorkspaceStart("local", storage)
  assert.deepEqual(
    initialWorkspace({
      localAvailable: true,
      start: readWorkspaceStart(storage),
    }),
    { open: "local" }
  )
})

test("welcomes back someone who signed out of an account", () => {
  const storage = memoryStorage()
  writeWorkspaceStart("local", storage)
  writeWorkspaceStart("signed-out", storage)
  const start = initialWorkspace({
    localAvailable: true,
    start: readWorkspaceStart(storage),
  })
  assert.deepEqual(start, { open: "sign-in", greeting: "signed-out" })
  assert.equal(
    signInTitle({ greeting: "signed-out", fromLocalWorkspace: false }).title,
    "Welcome back"
  )
})

test("asks to sign in where no local workspace can run", () => {
  assert.deepEqual(
    initialWorkspace({ localAvailable: false, start: "local" }),
    {
      open: "sign-in",
      greeting: "first-launch",
    }
  )
})

test("ignores an unknown stored choice", () => {
  const storage = memoryStorage()
  storage.setItem("blame.app.workspace-start.v1", "cloud")
  assert.equal(readWorkspaceStart(storage), undefined)
})

test("does not greet someone already in a local workspace", () => {
  assert.equal(
    signInTitle({ greeting: "first-launch", fromLocalWorkspace: true }).title,
    "Sign in to Blame"
  )
})
