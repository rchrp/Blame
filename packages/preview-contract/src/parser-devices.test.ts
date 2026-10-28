import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewManifest } from "./parser.js";

const device = { id: "ios", platform: "ios", projectDir: "ios", toolchain: "xcode", build: { workspace: "App.xcworkspace", scheme: "App" }, app: { bundleId: "com.example.App" } };
const manifest = (value = device) => ({ confidence: "high", project: {}, setup: [], caches: [], risks: [], probes: [], services: [], devices: [value] });
test("device targets validate toolchains, paths, commands and secrets", () => {
  assert.equal(parsePreviewManifest(manifest()).devices?.[0]!.id, "ios");
  for (const value of [{ ...device, platform: "android" }, { ...device, projectDir: "../host" }, { ...device, build: { scheme: "App", workspace: "../App.xcworkspace" } }, { ...device, build: {} }, { ...device, app: {} }, { ...device, prepare: ["sudo pod install"] }, { ...device, prepare: ["docker run image"] }, { ...device, environment: { TOKEN: ["sk", "live", "abcdefghijklmnopqrstuvwx12345678"].join("_") } }]) {
    assert.throws(() => parsePreviewManifest(manifest(value as typeof device)));
  }
});
test("device ids and references are scoped to existing services", () => {
  const value = manifest(); value.devices.push(device);
  assert.throws(() => parsePreviewManifest(value), /unique/);
  assert.throws(() => parsePreviewManifest(manifest({ ...device, dependsOn: ["missing"] } as typeof device)), /unknown service/);
});
