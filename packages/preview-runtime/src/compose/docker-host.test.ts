import assert from "node:assert/strict";
import test from "node:test";
import { commandFailureDetail } from "./docker-host.js";

test("preserves short Compose command output", () => {
  assert.equal(
    commandFailureDetail(" warning \n", " result \n"),
    "result\nwarning",
  );
});

test("keeps the end of each stream, with the error last", () => {
  const detail = commandFailureDetail(
    `Network Creating\n${"Container Created\n".repeat(100)}ERR_PNPM_LIFECYCLE postinstall failed`,
    `${"Progress: resolved 1853\n".repeat(100)}Progress: done`,
  );

  assert.ok(detail.length <= 1_000);
  assert.match(detail, /Compose output truncated/);
  assert.match(detail, /Progress: done\n/);
  assert.match(detail, /ERR_PNPM_LIFECYCLE postinstall failed$/);
});
