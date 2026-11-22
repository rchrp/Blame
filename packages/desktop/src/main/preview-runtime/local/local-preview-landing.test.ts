import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRunConfiguration } from "@blame/agent-runtime";
import { parsePreviewManifest } from "@blame/agent-runtime/preview-manifest";
import { compilePreviewManifest } from "@blame/preview-runtime";
import { previewLandingUrl } from "./local-preview-render.ts";

const hostPorts = { "web:http": 54_494 };

const rootHealth = { type: "http", path: "/", timeoutMs: 10_000 } as const;
const apiHealth = { type: "http", path: "/api/health", timeoutMs: 10_000 };

function plan(
  healthcheck: { type: "http"; path: string; timeoutMs: number } = rootHealth,
  protocol: "http" | "https" = "http",
) {
  return compilePreviewManifest(
    parsePreviewManifest({
      confidence: "high",
      project: { detectedStack: ["node"] },
      setup: [],
      services: [
        {
          id: "web",
          kind: "preview",
          container: { image: "node:22-bookworm-slim" },
          command: "npm run dev",
          endpoints: [
            {
              id: "http",
              protocol,
              port: 3000,
              healthcheck,
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    }),
  );
}

function configuration(previewUrl?: string): ProjectRunConfiguration {
  return {
    id: "web",
    name: "Web",
    command: "npm run dev",
    cwd: ".",
    category: "web",
    default: true,
    previewService: "web",
    services: ["web"],
    scopes: ["web"],
    ...(previewUrl ? { previewUrl } : {}),
  };
}

const origin = "http://localhost:54494";

test("lands on the root when the endpoint's healthcheck is a dedicated route", () => {
  assert.equal(
    previewLandingUrl(plan(apiHealth), hostPorts, configuration()),
    `${origin}/`,
  );
});

test("lands on the root when the healthcheck is the root", () => {
  assert.equal(
    previewLandingUrl(plan(rootHealth), hostPorts, configuration()),
    `${origin}/`,
  );
});

test("never lands on the healthcheck path without a selected configuration", () => {
  assert.equal(
    previewLandingUrl(plan(apiHealth), hostPorts, undefined),
    `${origin}/`,
  );
});

test("lands on the path and query of the run configuration's previewUrl", () => {
  assert.equal(
    previewLandingUrl(
      plan(apiHealth),
      hostPorts,
      configuration("http://localhost:3000/dashboard?tab=1#top"),
    ),
    `${origin}/dashboard?tab=1`,
  );
  assert.equal(
    previewLandingUrl(plan(), hostPorts, configuration("/docs")),
    `${origin}/docs`,
  );
  assert.equal(
    previewLandingUrl(plan(), hostPorts, configuration("localhost:3000/app")),
    `${origin}/app`,
  );
  assert.equal(
    previewLandingUrl(
      plan(apiHealth),
      hostPorts,
      configuration("http://localhost:3000"),
    ),
    `${origin}/`,
  );
});

test("ignores a previewUrl that names another port or cannot be read", () => {
  for (const previewUrl of [
    "http://localhost:6006/docs",
    "ftp://localhost:3000/docs",
    "http://",
  ])
    assert.equal(
      previewLandingUrl(plan(apiHealth), hostPorts, configuration(previewUrl)),
      `${origin}/`,
      previewUrl,
    );
});

test("keeps the endpoint's protocol and published port", () => {
  assert.equal(
    previewLandingUrl(
      plan(apiHealth, "https"),
      hostPorts,
      configuration("http://localhost:3000/settings"),
    ),
    "https://localhost:54494/settings",
  );
  assert.equal(
    previewLandingUrl(plan(apiHealth), {}, configuration()),
    undefined,
  );
});
