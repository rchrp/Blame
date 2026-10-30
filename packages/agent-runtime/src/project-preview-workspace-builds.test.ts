import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import { previewSetupIssues } from "./project-preview-validation.js";
import { workspaceBuildIssues } from "./project-preview-workspace-builds.js";
import { workspacePackageEvidence } from "./project-workspace-packages.js";
import type { PreviewManifest } from "./types.js";

// Shaped on Blame's own setup of 2026-10-30: the migration ran ace.js with
// `exec`, which skips the API's predev, and @blame/telemetry had no dist.

const scan = {
  files: {},
  workspacePackages: [
    pkg(".", "blame", false, [], { build: "turbo run build" }),
    pkg("packages/telemetry", "@blame/telemetry", true, [], { build: "tsc" }),
    pkg("packages/contract", "@blame/contract", true, [], { build: "tsc" }),
    pkg(
      "packages/api",
      "@blame/api",
      false,
      ["@blame/telemetry", "@blame/contract"],
      {
        predev: "pnpm --filter @blame/telemetry build",
        dev: "node ace.js serve --hmr",
      },
    ),
    pkg("packages/app", "@blame/app", false, ["@blame/contract"], {
      dev: "vite",
    }),
    pkg(
      "packages/desktop",
      "@blame/desktop",
      false,
      ["@blame/telemetry", "@blame/contract"],
      {
        predev: "pnpm run build:workspace-dependencies",
        "build:workspace-dependencies":
          "node scripts/build-workspace-dependencies.mjs",
        dev: "electron-vite dev",
      },
    ),
  ],
} as unknown as ProjectInitializationScan;

function pkg(
  path: string,
  name: string,
  buildOutput: boolean,
  workspaceDependencies: string[],
  scripts: Record<string, string>,
) {
  return { path, name, buildOutput, workspaceDependencies, scripts };
}

function manifest(
  setup: Array<{ id: string; command: string; dependsOn?: string[] }>,
) {
  const task = (id: string, workingDir: string, command: string) => ({
    id,
    kind: "preview",
    container: { image: "node:24-bookworm" },
    workingDir,
    command: `corepack prepare pnpm@12.15.0 --activate && ${command}`,
    endpoints: [],
  });
  return {
    confidence: "high",
    project: {},
    setup: setup.map((step) => ({
      container: { image: "node:24-bookworm" },
      workingDir: "/workspace",
      ...step,
    })),
    services: [
      { ...task("database", "/", "mysqld"), kind: "dependency" },
      task("api", "/workspace", "corepack pnpm --filter @blame/api dev"),
      task(
        "app",
        "/workspace/packages/app",
        "corepack pnpm dev --host 0.0.0.0",
      ),
      task(
        "desktop",
        "/workspace/packages/desktop",
        "corepack pnpm dev -- --no-sandbox",
      ),
    ],
    caches: [],
    risks: [],
    probes: [],
  } as unknown as PreviewManifest;
}

const install = { id: "deps", command: "corepack pnpm install" };
const migrate = {
  id: "migrate",
  command: "corepack pnpm --filter @blame/api exec node ace.js migration:run",
  dependsOn: ["database"],
};

function missing(setup: Parameters<typeof manifest>[0]) {
  return workspaceBuildIssues(manifest(setup), scan).map(({ rule }) => {
    const [, packages, task] =
      /packages (.+) in a setup task, .* before (\S+) runs/.exec(rule) ?? [];
    return `${task}: ${packages}`;
  });
}

test("asks to build the workspace packages a task loads from dist", () => {
  assert.deepEqual(missing([install, migrate]), [
    "migrate: @blame/contract, @blame/telemetry",
    // The API's predev builds telemetry; the desktop's builds everything.
    "api: @blame/contract",
    "app: @blame/contract",
  ]);
  const issues = previewSetupIssues(manifest([install, migrate]), scan);
  assert.ok(
    issues.some(
      ({ severity, rule }) =>
        severity === "blocking" &&
        rule.includes(
          "corepack pnpm --filter @blame/contract --filter @blame/telemetry run build",
        ),
    ),
  );
});

test("accepts the usual ways of building them first", () => {
  for (const build of [
    'corepack pnpm --filter "@blame/api^..." --filter "@blame/app^..." run build',
    "corepack pnpm exec turbo run build --filter=@blame/api^...",
    "corepack pnpm -r build",
    "corepack pnpm build",
    "cd packages/contract && corepack pnpm build && cd ../telemetry && corepack pnpm run build",
    "corepack pnpm --filter ./packages/contract build && corepack pnpm -F @blame/telemetry build",
  ])
    assert.deepEqual(
      missing([
        { ...install, command: `${install.command} && ${build}` },
        migrate,
      ]),
      [],
      build,
    );
});

test("a build ordered after the task does not count for it", () => {
  assert.deepEqual(
    missing([
      install,
      migrate,
      {
        id: "build",
        command: "corepack pnpm -r build",
        dependsOn: ["migrate"],
      },
    ]),
    ["migrate: @blame/contract, @blame/telemetry"],
  );
});

test("the scan reads each package.json in full", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-workspace-"));
  try {
    const write = async (path: string, json: object) => {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(
        join(root, path, "package.json"),
        JSON.stringify(json, null, 2),
      );
    };
    await write(".", { name: "root", private: true });
    await write("packages/telemetry", {
      name: "@x/telemetry",
      exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } },
      scripts: { build: "tsc", test: "node --test" },
    });
    await write("packages/api", {
      name: "@x/api",
      imports: Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `#alias${i}/*`,
          `./app/alias${i}/*.js`,
        ]),
      ),
      scripts: { dev: "node ace serve", lint: "eslint ." },
      dependencies: { "@x/telemetry": "workspace:*", luxon: "^3" },
    });
    await write("docs/example", { name: "@x/example" });
    const packages = await workspacePackageEvidence(root, [
      "package.json",
      "packages/telemetry/package.json",
      "packages/api/package.json",
      "docs/example/package.json",
    ]);
    assert.deepEqual(
      packages?.map(
        ({ path, name, buildOutput, workspaceDependencies, scripts }) => ({
          path,
          name,
          buildOutput,
          workspaceDependencies,
          scripts,
        }),
      ),
      [
        {
          path: ".",
          name: "root",
          buildOutput: false,
          workspaceDependencies: [],
          scripts: {},
        },
        {
          path: "packages/telemetry",
          name: "@x/telemetry",
          buildOutput: true,
          workspaceDependencies: [],
          scripts: { build: "tsc" },
        },
        {
          path: "packages/api",
          name: "@x/api",
          buildOutput: false,
          workspaceDependencies: ["@x/telemetry"],
          scripts: { dev: "node ace serve" },
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
