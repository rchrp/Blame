import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyPublishedRuntime } from "./release-preflight.mjs";

function manifestFixture(base) {
  const artifact = { url: `${base}/image`, sha256: "a".repeat(64) };
  return { runtimeVersion: "9", artifacts: { windows: { amd64: artifact, arm64: artifact }, macos: { x86_64: artifact, aarch64: artifact } } };
}

test("release preflight distinguishes unavailable manifests, wrong versions and missing images", async () => {
  let body;
  let status = 200;
  const server = createServer((request, response) => { response.writeHead(status); response.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.BLAME_RUNTIME_MANIFEST_URL;
  process.env.BLAME_RUNTIME_MANIFEST_URL = `http://127.0.0.1:${server.address().port}/manifest`;
  try {
    body = manifestFixture(process.env.BLAME_RUNTIME_MANIFEST_URL);
    await verifyPublishedRuntime("9");
    body.runtimeVersion = "8";
    await assert.rejects(verifyPublishedRuntime("9"), /does not match/);
    status = 404;
    await assert.rejects(verifyPublishedRuntime("9"), /HTTP 404/);
    status = 200;
    body = manifestFixture(process.env.BLAME_RUNTIME_MANIFEST_URL);
    await assert.rejects(verifyPublishedRuntime("9", async () => ({ ok: false, status: 404 })), /windows\/amd64.*HTTP 404/);
    delete body.artifacts.macos.aarch64;
    await assert.rejects(verifyPublishedRuntime("9"), /missing a verified macos\/aarch64/);
  } finally {
    if (previous === undefined) delete process.env.BLAME_RUNTIME_MANIFEST_URL;
    else process.env.BLAME_RUNTIME_MANIFEST_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test("macOS verification stops after a failed intermediate check", async () => {
  const source = await readFile(new URL("./macos-runtime-image.mjs", import.meta.url), "utf8");
  const expression = source.match(/const checks = (\[[\s\S]*?\]\.join\("\\n"\));/)[1];
  const script = new Function("runtimeVersion", "nodeVersion", `return ${expression}`)("9", "22");
  const result = spawnSync("sh", ["-c", `grep() { return 42; }\n${script}`], { encoding: "utf8" });
  assert.equal(result.status, 42);
});
