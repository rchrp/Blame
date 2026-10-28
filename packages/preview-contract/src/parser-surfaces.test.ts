import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewManifest } from "./parser.js";

const manifest = (surface: unknown, extra = {}) => ({
  confidence: "high",
  project: {},
  setup: [],
  caches: [],
  risks: [],
  probes: [],
  services: [
    {
      id: "cli",
      kind: "preview",
      container: { image: "python:3.13-slim" },
      command: "python -q",
      endpoints: [],
      surface,
      ...extra,
    },
  ],
});

test("terminal and display defaults and dimensions", () => {
  assert.deepEqual(
    parsePreviewManifest(manifest({ type: "terminal" })).services[0]!.surface,
    { type: "terminal", columns: 120, rows: 32 },
  );
  assert.deepEqual(
    parsePreviewManifest(manifest({ type: "display" })).services[0]!.surface,
    { type: "display", width: 1280, height: 800 },
  );
  for (const surface of [
    { type: "unknown" },
    { type: "terminal", columns: 39 },
    { type: "terminal", rows: 101 },
    { type: "display", width: 4000 },
    { type: "web", device: "watch" },
  ]) {
    assert.throws(() => parsePreviewManifest(manifest(surface)));
  }
});

test("surface kinds, reserved endpoints and sidecar ids", () => {
  assert.throws(
    () =>
      parsePreviewManifest(manifest({ type: "terminal" }, { kind: "worker" })),
    /only accepted/,
  );
  assert.throws(
    () =>
      parsePreviewManifest(
        manifest(
          { type: "terminal" },
          { endpoints: [{ id: "terminal", protocol: "http", port: 9000 }] },
        ),
      ),
    /reserved/,
  );
  const value = manifest({ type: "display" });
  value.services.push({ ...value.services[0]!, id: "cli__display" });
  assert.throws(() => parsePreviewManifest(value), /reserved/);
});
