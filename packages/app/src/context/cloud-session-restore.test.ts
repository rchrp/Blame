import assert from "node:assert/strict"
import test from "node:test"

import { sessionRejected } from "./cloud-session-restore.ts"

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

test("only the account refusing the token ends the session", () => {
  assert.equal(sessionRejected(new ApiError("Unauthenticated", 401)), true)
  assert.equal(sessionRejected(new ApiError("Forbidden", 403)), true)
})

test("an unreachable or failing API keeps the session", () => {
  assert.equal(sessionRejected(new TypeError("fetch failed")), false)
  assert.equal(sessionRejected(new ApiError("Bad gateway", 502)), false)
  assert.equal(sessionRejected(new ApiError("Unavailable", 503)), false)
  assert.equal(sessionRejected(undefined), false)
})
