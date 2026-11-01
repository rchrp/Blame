import assert from "node:assert/strict";
import test from "node:test";
import { compilePreviewManifest } from "../compilation/manifest-compiler.js";
import { previewResourceSize } from "./preview-resource-size.js";

const displayImage = `ghcr.io/rchrp/blame-preview-display@sha256:${"a".repeat(64)}`;

function vcpus(services: object[]) {
  return previewResourceSize(
    compilePreviewManifest(
      {
        confidence: "high",
        project: {},
        setup: [],
        caches: [],
        risks: [],
        probes: [],
        services,
      },
      { displayImage },
    ),
  ).vcpus;
}

const web = (command: string) => ({
  id: "web",
  kind: "preview",
  container: { image: "node:22-bookworm" },
  workingDir: "/workspace",
  command,
  endpoints: [
    {
      id: "http",
      protocol: "http",
      port: 5173,
      healthcheck: { type: "http", path: "/", timeoutMs: 30000 },
    },
  ],
});
const database = {
  id: "database",
  kind: "dependency",
  container: { image: "postgres:17-bookworm" },
  endpoints: [{ id: "postgres", protocol: "tcp", port: 5432 }],
};
const api = {
  id: "api",
  kind: "worker",
  container: { image: "node:22-bookworm" },
  workingDir: "/workspace",
  command: "node server.js",
  endpoints: [{ id: "http", protocol: "http", port: 3333 }],
};
const desktop = {
  id: "desktop",
  kind: "preview",
  container: { image: "node:22-bookworm" },
  workingDir: "/workspace",
  command: "corepack pnpm dev",
  surface: { type: "display" },
  endpoints: [],
};

test("sizes a cloud sandbox from what the preview runs", () => {
  // A light app alone gets the smallest sandbox.
  assert.equal(vcpus([web("corepack pnpm dev --host 0.0.0.0")]), 1);
  // A heavy dev server or a database needs the default.
  assert.equal(vcpus([web("corepack pnpm next dev")]), 2);
  assert.equal(vcpus([web("corepack pnpm dev"), database]), 2);
  // A screen alone stays at the default; with a backend it doubles.
  assert.equal(vcpus([desktop]), 2);
  assert.equal(vcpus([desktop, api, database]), 4);
  // Five services or more.
  const workers = [1, 2, 3, 4].map((index) => ({ ...api, id: `api${index}` }));
  assert.equal(vcpus([web("corepack pnpm dev"), ...workers]), 4);
});
