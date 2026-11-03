import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudPreviewEnvironment } from "./cloud-environment.ts";

const manifest = {
  confidence: "high",
  project: { root: "." },
  setup: [
    {
      id: "migrate",
      container: { image: "node:24" },
      workingDir: "/workspace",
      command: "node migrate.js",
    },
  ],
  services: [
    {
      id: "api",
      kind: "preview",
      container: { image: "node:24" },
      workingDir: "/workspace",
      command: "node server.js",
      environment: { HOST: "0.0.0.0", PORT: "3000", LOG_LEVEL: "info" },
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 5000 },
        },
      ],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
};

test("sends a cloud preview the variables and env files a local one would have", async (t) => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-cloud-env-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", worktree]);
  await mkdir(join(worktree, ".blame", "initialization"), { recursive: true });
  await writeFile(
    join(worktree, ".blame", "initialization", "preview-manifest.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(worktree, ".env"),
    "DATABASE_URL=postgres://me:pw@db.example.com/app\nLOG_LEVEL=debug\nPORT=4000\n",
  );
  const environment = await cloudPreviewEnvironment(worktree);
  // The listen port stays Blame's; LOG_LEVEL comes from .env, in its file.
  assert.deepEqual(environment.variables, {
    "setup-migrate": {},
    api: { HOST: "0.0.0.0", PORT: "3000" },
  });
  assert.deepEqual(environment.files, [
    {
      path: ".env",
      content:
        "DATABASE_URL=postgres://me:pw@db.example.com/app\nLOG_LEVEL=debug\nPORT=3000\nHOST=0.0.0.0\n",
    },
  ]);
});
