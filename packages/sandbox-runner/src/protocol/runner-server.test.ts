import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshFencingToken, boundedMessage } from "./runner-server.js";

test("rejects commands from a stale control-plane worker", () => {
  assert.doesNotThrow(() => assertFreshFencingToken(7, 7));
  assert.doesNotThrow(() => assertFreshFencingToken(7, 8));
  assert.throws(
    () => assertFreshFencingToken(8, 7),
    (error) =>
      (error as { runnerCode?: string }).runnerCode === "STALE_FENCING_TOKEN",
  );
});

test("long error messages keep their cause at the end", () => {
  const message = `Compose run failed: ${"Progress: resolved 1853\n".repeat(100)}ERR_PNPM_GIT_FETCHER_IO`;
  const bounded = boundedMessage(message);
  assert.equal(bounded.length, 1_500);
  assert.match(bounded, /^Compose run failed: /);
  assert.match(bounded, /ERR_PNPM_GIT_FETCHER_IO$/);
  assert.equal(boundedMessage("short"), "short");
});
