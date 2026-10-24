import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the bundled runner starts without an ESM dynamic-require failure", () => {
  const bundle = fileURLToPath(
    new URL("../dist/blame-sandbox-runner.cjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [bundle, "unsupported"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported blame sandbox runner command/);
  assert.doesNotMatch(result.stderr, /Dynamic require/);
});
