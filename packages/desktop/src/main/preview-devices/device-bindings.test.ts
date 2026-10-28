import assert from "node:assert/strict";
import test from "node:test";
import { deviceBindings } from "./device-bindings.ts";
import type { PreviewManifest, PreviewManifestDeviceTarget } from "@blame/preview-contract";

test("iOS binds published host ports; Android binds reverse-forwarded logical ports", () => {
  const manifest: PreviewManifest = { confidence: "high", project: {}, setup: [], caches: [], risks: [], probes: [], services: [{ id: "api", kind: "worker", container: { image: "node" }, command: "node server", endpoints: [{ id: "http", protocol: "http", port: 3000 }] }] };
  const target: PreviewManifestDeviceTarget = { id: "app", platform: "ios", toolchain: "expo", projectDir: ".", build: {}, app: { bundleId: "com.example.App" }, dependsOn: ["api"], bindings: [{ target: { type: "environment", key: "API_URL" }, source: { service: "api", endpoint: "http" } }] };
  const routes = [{ serviceId: "api", endpointId: "http", port: 51000 }];
  assert.equal(deviceBindings(target, manifest, routes).environment.API_URL, "http://127.0.0.1:51000");
  const android = deviceBindings({ ...target, platform: "android" }, manifest, routes);
  assert.equal(android.environment.API_URL, "http://localhost:3000");
  assert.deepEqual(android.reverse, [{ devicePort: 3000, hostPort: 51000 }]);
  assert.throws(() => deviceBindings(target, manifest, []), /not ready/);
});
