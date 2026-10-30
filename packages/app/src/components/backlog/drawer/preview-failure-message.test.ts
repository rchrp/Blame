import assert from "node:assert/strict"
import test from "node:test"

import { readableFailure } from "./preview-failure-message.ts"

test("keeps only the failure the desktop reported", () => {
  assert.equal(
    readableFailure(
      "Error invoking remote method 'workspace:control-project-preview': PreviewRuntimeError: Preview container cannot become ready (exited): [dev] Docker is not running."
    ),
    "Preview container cannot become ready (exited): [dev] Docker is not running."
  )
  assert.equal(
    readableFailure("Preview did not respond"),
    "Preview did not respond"
  )
})

test("drops the colors of quoted command output", () => {
  assert.equal(
    readableFailure(
      "Compose run failed (exit code 1): \u001b[31mℹ EnvValidationException\u001b[39m"
    ),
    "Compose run failed (exit code 1): ℹ EnvValidationException"
  )
})

test("keeps the message of a cloud request failure", () => {
  const raw =
    "Error invoking remote method 'preview-runtime:command': CloudPreviewRequestError: Cloud preview request failed (422): " +
    JSON.stringify({
      failure: {
        code: "ENGINE_START_FAILED",
        message:
          "Compose run failed (exit code 1): Error: getaddrinfo EAI_AGAIN",
      },
    })
  assert.equal(
    readableFailure(raw),
    "Compose run failed (exit code 1): Error: getaddrinfo EAI_AGAIN"
  )
  // The IPC layer can cut the body short.
  assert.match(readableFailure(raw.slice(0, -40)), /^Compose run failed \(/)
})
