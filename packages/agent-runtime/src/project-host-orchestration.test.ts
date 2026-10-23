import assert from "node:assert/strict";
import test from "node:test";

import {
  hostOrchestratedManifestCommand,
  hostOrchestrationChain,
  referencedScriptFiles,
} from "./project-host-orchestration.js";
import type { PreviewManifest } from "./types.js";

const dockerWrapper = `// \`pnpm dev\`: starts Docker, the database, then Next.js.
import { spawn, spawnSync } from "node:child_process";
const dockerIsUp = () =>
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
function run(command, args) { spawnSync(command, args, { stdio: "inherit" }); }
run("docker", ["compose", "up", "--detach", "--wait", "db"]);
spawn("pnpm", ["--filter", "web", "dev"], { stdio: "inherit" });
`;

function monorepoFiles(rootDev: string) {
  return {
    "package.json": JSON.stringify({
      name: "portfolio",
      scripts: {
        dev: rootDev,
        "dev:web": "pnpm --filter web dev",
        "db:up": "docker compose up --detach --wait db",
      },
    }),
    "apps/web/package.json": JSON.stringify({
      name: "web",
      scripts: { dev: "prisma generate && next dev" },
    }),
    "scripts/dev.mjs": dockerWrapper,
  };
}

function manifestWithCommand(
  command: string,
  workingDir = "/workspace",
): PreviewManifest {
  return {
    confidence: "high",
    project: { root: ".", detectedStack: ["node"], confidence: "high" },
    setup: [],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:22-bookworm" },
        workingDir,
        command,
        endpoints: [{ id: "http", protocol: "http", port: 3000 }],
      },
    ],
    caches: [],
    risks: [],
    probes: [],
  };
}

test("flags a package script that delegates to a Docker wrapper file", () => {
  const finding = hostOrchestratedManifestCommand(
    manifestWithCommand(
      "corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev --webpack",
    ),
    monorepoFiles("node scripts/dev.mjs"),
  );
  assert.deepEqual(finding?.chain, [
    'package.json script "dev"',
    "scripts/dev.mjs",
  ]);
  assert.equal(finding?.owner, "service web");
});

test("accepts the application server the wrapper starts", () => {
  const files = monorepoFiles("node scripts/dev.mjs");
  for (const command of [
    "corepack pnpm --filter web dev",
    "corepack pnpm --filter=web dev",
    "corepack pnpm dev:web",
    "cd apps/web && corepack pnpm dev",
  ]) {
    assert.equal(
      hostOrchestratedManifestCommand(manifestWithCommand(command), files),
      undefined,
      command,
    );
  }
  assert.equal(
    hostOrchestratedManifestCommand(
      manifestWithCommand("corepack pnpm dev", "/workspace/apps/web"),
      files,
    ),
    undefined,
  );
});

test("follows nested package scripts and inline container commands", () => {
  const files = monorepoFiles("pnpm db:up && pnpm dev:web");
  assert.deepEqual(hostOrchestrationChain("npm run dev", ".", files), [
    'package.json script "dev"',
    'package.json script "db:up"',
  ]);
});

test("ignores Docker mentioned only in comments or messages", () => {
  const files = {
    "package.json": JSON.stringify({
      scripts: { dev: "node scripts/dev.mjs" },
    }),
    "scripts/dev.mjs": [
      "// Previously: docker compose up db",
      '/* run("docker", ["info"]) */',
      'console.log("Docker is optional here");',
      'spawn("next", ["dev"]);',
    ].join("\n"),
  };
  assert.equal(
    hostOrchestrationChain("corepack pnpm dev", ".", files),
    undefined,
  );
});

test("detects shell wrappers that start containers", () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { dev: "./scripts/dev.sh" } }),
    "scripts/dev.sh":
      "#!/bin/sh\n# start the db\ndocker compose up -d db\nexec next dev\n",
  };
  assert.deepEqual(hostOrchestrationChain("corepack pnpm dev", ".", files), [
    'package.json script "dev"',
    "scripts/dev.sh",
  ]);
});

test("lists script files referenced by package scripts for the scan", () => {
  const files = monorepoFiles("node scripts/dev.mjs");
  const withoutWrapper: Record<string, string> = { ...files };
  delete withoutWrapper["scripts/dev.mjs"];
  assert.deepEqual(referencedScriptFiles(withoutWrapper), ["scripts/dev.mjs"]);
  assert.deepEqual(referencedScriptFiles(files), []);
  const sampled = { ...files, "scripts/dev.mjs": "// header\n[truncated]" };
  assert.deepEqual(referencedScriptFiles(sampled), ["scripts/dev.mjs"]);
});
