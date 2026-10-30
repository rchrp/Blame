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
