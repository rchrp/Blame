import assert from "node:assert/strict"
import test from "node:test"
import {
  screenshotItemsFromActivities,
  screenshotStore,
} from "./screenshot-items.ts"

const id = "a".repeat(64)

test("a screenshot that is also an engine image is read as the engine image", () => {
  const [item] = screenshotItemsFromActivities([
    {
      kind: "tool",
      detail: JSON.stringify({
        output: [{ type: "screenshot_ref", id, sessionId: "session-1" }],
      }),
      images: [{ id, caption: "" }],
    },
  ])
  assert.equal(item?.blob, true)
  assert.equal(item?.ref?.sessionId, "session-1")
  assert.equal(screenshotStore(item, "loading"), "engine")
  assert.equal(screenshotStore(item, "ready"), "engine")
})

test("an engine image the account lacks is read from this device", () => {
  // A merged story's session leaves this computer with its images; the
  // agent screenshot of the same sha256 may still be here.
  assert.equal(screenshotStore({ blob: true }, "unavailable"), "device")
})

test("an agent screenshot is always read from this device first", () => {
  assert.equal(screenshotStore({}, "unavailable"), "device")
  assert.equal(screenshotStore(undefined, "unavailable"), "device")
})
