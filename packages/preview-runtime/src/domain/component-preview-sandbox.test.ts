import assert from "node:assert/strict";
import test from "node:test";
import {
  componentPreviewSandbox,
  parseComponentPreviewSandboxCursor,
  parseComponentPreviewSandboxStart,
  withComponentPreviewGatewayPort,
} from "./component-preview-sandbox.js";

test("the component preview port is reserved while the provider has room", () => {
  const { gatewayPort } = componentPreviewSandbox;
  assert.deepEqual(withComponentPreviewGatewayPort([]), [gatewayPort]);
  assert.deepEqual(withComponentPreviewGatewayPort([43_000, 43_001]), [
    43_000,
    43_001,
    gatewayPort,
  ]);
  assert.deepEqual(withComponentPreviewGatewayPort([43_000, gatewayPort]), [
    43_000,
    gatewayPort,
  ]);
  const full = Array.from({ length: 15 }, (_, index) => 43_000 + index);
  assert.deepEqual(withComponentPreviewGatewayPort(full), full);
  assert.equal(withComponentPreviewGatewayPort(full.slice(1)).length, 15);
});

test("a server start needs node arguments and a port outside the reserved one", () => {
  const start = {
    nodeArguments: ["--input-type=module", "-e", ""],
    port: 51_234,
  };
  assert.deepEqual(parseComponentPreviewSandboxStart(start), {
    ok: true,
    value: start,
  });
  for (const invalid of [
    undefined,
    { ...start, nodeArguments: [] },
    { ...start, nodeArguments: ["-e", 3] },
    { ...start, nodeArguments: ["a\0b"] },
    { ...start, nodeArguments: ["x".repeat(512 * 1024 + 1)] },
    { ...start, port: 1_023 },
    { ...start, port: 65_536 },
    { ...start, port: 4_000.5 },
    { ...start, port: componentPreviewSandbox.gatewayPort },
  ])
    assert.equal(parseComponentPreviewSandboxStart(invalid).ok, false);
});

test("an output cursor starts at zero and counts characters", () => {
  assert.deepEqual(parseComponentPreviewSandboxCursor(undefined), {
    stderr: 0,
    stdout: 0,
  });
  assert.deepEqual(
    parseComponentPreviewSandboxCursor({ stderr: 3, stdout: 120 }),
    {
      stderr: 3,
      stdout: 120,
    },
  );
  for (const invalid of [
    null,
    { stdout: -1, stderr: 0 },
    { stdout: 1 },
    [1, 2],
  ])
    assert.equal(parseComponentPreviewSandboxCursor(invalid), undefined);
});
