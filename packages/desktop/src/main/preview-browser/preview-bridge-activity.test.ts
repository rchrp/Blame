import assert from "node:assert/strict";
import test from "node:test";
import { PreviewBridgeActivity } from "./preview-bridge-activity.ts";

test("reports the requests a stuck preview proxy still holds", () => {
  const activity = new PreviewBridgeActivity(() => 4321);
  const page = activity.start("http", "http://localhost:3000/?token=secret");
  const chunk = activity.start("http", "http://localhost:3000/_next/app.js");
  page.stage("upstream");
  chunk.stage("response");
  chunk.done();
  const refreshed = activity.refreshStarted();
  const snapshot = activity.snapshot();
  assert.equal(snapshot.port, 4321);
  assert.equal(snapshot.forwarded, 1);
  assert.deepEqual(
    snapshot.open.map(({ path, stage }) => ({ path, stage })),
    [{ path: "/", stage: "upstream" }],
  );
  // A refresh still running has no duration yet.
  assert.equal(snapshot.lastRefresh?.durationMs, null);
  refreshed(new Error("Preview routes did not refresh in time"));
  page.fail(new Error("Preview routes did not refresh in time"));
  const after = activity.snapshot();
  assert.equal(after.failed, 1);
  assert.equal(after.openCount, 0);
  assert.equal(after.lastFailure?.path, "/");
  assert.match(after.lastRefresh?.error ?? "", /did not refresh/);
  // A request that already finished is not failed again when its socket closes.
  chunk.fail(new Error("closed"));
  assert.equal(activity.snapshot().failed, 1);
});
