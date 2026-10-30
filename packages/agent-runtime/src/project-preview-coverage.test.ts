import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import { previewSetupIssues } from "./project-preview-validation.js";
import { parsePreviewManifest } from "./preview-manifest.js";

// Shaped on the scans and submissions of 2026-10-30: a pnpm workspace with
// an AdonisJS API and an Electron app, and a Next.js site using Prisma.

const workspace = {
  files: {
    "package.json":
      '{"name":"blame","scripts":{"dev":"node scripts/dev-with-database-tunnel.mjs"}}',
    // Scanned manifests can be cut short.
    "packages/api/package.json":
      '{\n  "name": "@blame/api",\n  "scripts": {"dev": "node ace serve --hmr"',
    "packages/api/adonisrc.ts": "export default defineConfig({})",
    "packages/api/.env.example":
      "PORT=3333\nHOST=localhost\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASSWORD=\nDB_DATABASE=blame",
    "packages/desktop/package.json":
      '{\n  "name": "@blame/desktop",\n  "scripts": {"dev": "electron-vite dev"',
    "tools/fixture/package.json":
      '{"name":"fixture","devDependencies":{"electron":"1"},"scripts":{"dev":"x"}}',
  },
} as unknown as ProjectInitializationScan;

const prismaSite = {
  files: {
    "apps/web/package.json":
      '{"name":"web","dependencies":{"@prisma/client":"^7"},"devDependencies":{"prisma":"^7"}}',
  },
} as unknown as ProjectInitializationScan;

function manifest(input: {
  image?: string;
  migrate?: Record<string, string>;
  api?: Record<string, string> | false;
  display?: boolean;
}) {
  const image = input.image ?? "node:24-bookworm";
  return parsePreviewManifest({
    confidence: "high",
    project: { root: ".", detectedStack: ["node"], confidence: "high" },
    setup: [
      {
        id: "install",
        container: { image },
        workingDir: "/workspace",
        command: "corepack pnpm install",
      },
      {
        id: "migrate",
        container: { image },
        workingDir: "/workspace",
        command:
          "corepack pnpm --filter @blame/api exec node ace.js migration:run",
        environment: input.migrate ?? {},
        dependsOn: ["mysql"],
      },
    ],
    services: [
      {
        id: "mysql",
        kind: "dependency",
        container: { image: "mysql:8.4" },
        endpoints: [{ id: "mysql", protocol: "tcp", port: 3306 }],
      },
      ...(input.api === false
        ? []
        : [
            {
              id: "api",
              kind: "worker",
              container: { image },
              workingDir: "/workspace",
              command: "corepack pnpm --filter @blame/api dev",
              environment: input.api ?? {},
              dependsOn: ["mysql"],
              endpoints: [{ id: "http", protocol: "http", port: 3333 }],
            },
          ]),
      ...(input.display
        ? [
            {
              id: "desktop",
              kind: "preview",
              container: { image },
              workingDir: "/workspace/packages/desktop",
              command: "corepack pnpm dev -- --no-sandbox",
              surface: { type: "display" },
              endpoints: [],
            },
          ]
        : []),
    ],
    caches: [],
    risks: [],
    probes: [],
  });
}

const database = {
  DB_HOST: "mysql",
  DB_PORT: "3306",
  DB_USER: "blame",
  DB_PASSWORD: "blame",
  DB_DATABASE: "blame",
};

const rules = (issues: ReturnType<typeof previewSetupIssues>) =>
  issues.map(({ severity, rule }) => `${severity}: ${rule}`);

test("asks for the database settings a backend reads, under its names", () => {
  const issues = rules(
    previewSetupIssues(
      manifest({
        migrate: { DATABASE_URL: "mysql://blame:blame@mysql:3306/blame" },
        api: { DATABASE_URL: "mysql://blame:blame@mysql:3306/blame" },
        display: true,
      }),
      workspace,
    ),
  );
  assert.equal(issues.filter((rule) => rule.includes("DB_HOST")).length, 2);
  assert.match(issues[0]!, /^warning: must give migrate .*DB_DATABASE/);
  assert.deepEqual(
    rules(
      previewSetupIssues(
        manifest({ migrate: database, api: database, display: true }),
        workspace,
      ),
    ),
    [],
  );
});

test("asks to run a backend and an Electron app the project has", () => {
  const issues = rules(
    previewSetupIssues(manifest({ migrate: database, api: false }), workspace),
  );
  assert.equal(issues.length, 2);
  assert.match(issues[0]!, /AdonisJS backend in packages\/api as a service/);
  assert.match(issues[1]!, /Electron app in packages\/desktop/);
});

test("refuses Prisma in an image without OpenSSL", () => {
  const slim = rules(
    previewSetupIssues(
      manifest({ image: "node:24-bookworm-slim", api: false }),
      prismaSite,
    ),
  );
  assert.equal(slim.length, 1);
  assert.match(
    slim[0]!,
    /^blocking: must run Prisma in an image that ships OpenSSL/,
  );
  assert.deepEqual(
    rules(previewSetupIssues(manifest({ api: false }), prismaSite)),
    [],
  );
});
