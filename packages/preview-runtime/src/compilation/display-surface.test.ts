import assert from "node:assert/strict";
import test from "node:test";
import { compilePreviewManifest } from "./manifest-compiler.js";
import { renderCompose } from "../compose/compose-renderer.js";
import { parse } from "yaml";
import { displayActionCommand } from "../compose/display-actions.js";
import { waitForDisplayWindows } from "../compose/display-readiness.js";

const manifest = { confidence: "high", project: {}, setup: [], caches: [], risks: [], probes: [], services: [{ id: "app", kind: "preview", container: { image: "project-gui" }, command: "./app", surface: { type: "display" }, endpoints: [] }] };
const image = `ghcr.io/rchrp/blame-preview-display@sha256:${"a".repeat(64)}`;
test("display compiles a healthy sidecar and a private per-app X11 volume", () => {
  const plan = compilePreviewManifest(manifest, { displayImage: image });
  assert.equal(plan.version, 3);
  assert.equal(plan.services.length, 2);
  assert.equal(plan.services[0]!.environment.DISPLAY, ":99");
  assert.deepEqual(plan.services[0]!.dependsOn, ["app__display"]);
  assert.equal(plan.networking.gatewayListeners[0]!.serviceId, "app__display");
  const yaml = parse(renderCompose(plan, { kind: "local", projectName: "story", workspacePath: "/work", dependencyKey: "d", projectUser: "1000:1000", hostPorts: { "app__display:display": 50000 } }).yaml);
  assert.equal(yaml.services.app.shm_size, "1g");
  assert.equal(yaml.services.app.depends_on.app__display.condition, "service_healthy");
  const volume = yaml.services.app.volumes.find((v: string) => v.endsWith(":/tmp/.X11-unix"));
  assert.ok(yaml.services.app__display.volumes.includes(volume));
  assert.equal(yaml.services.app__display.image, image);
  assert.throws(() => compilePreviewManifest(manifest, { displayImage: "latest" }), /published display image/);
});
test("screen actions cannot become shell commands and readiness requires a window", async () => {
  assert.deepEqual(displayActionCommand({ action: "type", text: "'$(anything)" }), ["blame-display", "type", "'$(anything)"]);
  assert.throws(() => displayActionCommand({ action: "click", x: -1, y: 0 }));
  const plan = compilePreviewManifest(manifest, { displayImage: image });
  await waitForDisplayWindows(plan, ["app"], async () => ({ exitCode: 0, stdout: '[{"title":"Hello"}]', stderr: "" }), { timeoutMs: 1 });
  await assert.rejects(waitForDisplayWindows(plan, ["app"], async () => ({ exitCode: 0, stdout: '[]', stderr: "" }), { timeoutMs: 1 }), /opened no window/);
});
