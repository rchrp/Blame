import assert from "node:assert/strict";
import test from "node:test";
import { runnerPinSource } from "./sandbox-runner-pin.mjs";

const image = `vcr.vercel.com/team/project/blame-runner@sha256:${"a".repeat(64)}`;

test("runner pins hold an immutable image and a semantic version", () => {
  const source = runnerPinSource(image, "0.3.0");
  assert.match(
    source,
    /image:\n    'vcr\.vercel\.com\/team\/project\/blame-runner@sha256:a{64}'/,
  );
  assert.match(source, /version: '0\.3\.0'/);
  assert.throws(
    () => runnerPinSource("vcr.vercel.com/x/blame-runner:0.3.0", "0.3.0"),
    /digest/,
  );
  assert.throws(
    () => runnerPinSource(`${image}'; process.exit()`, "0.3.0"),
    /digest/,
  );
  assert.throws(() => runnerPinSource(image, "latest"), /semantic/);
});
