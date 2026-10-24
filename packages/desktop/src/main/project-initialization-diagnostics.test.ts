import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  collectProjectInitializationDiagnostics,
  sanitizeProjectDiagnostic,
} from "./project-initialization-diagnostics.ts";
import { createContainerRuntime } from "./container-runtime.ts";

test("collects compose configuration, status, and every service log", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-diagnostics-"));
  const bin = join(root, "bin");
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".blame", "initialization"), { recursive: true });
  await mkdir(join(worktree, ".blame", "logs"), { recursive: true });
  await mkdir(bin);
  await writeFile(
    join(worktree, ".blame", "logs", "setup.log"),
    "setup failed",
  );
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
if [[ "$*" == *"config --services"* ]]; then printf "web\\nworker\\n"; exit 0; fi
if [[ "$*" == *"config"* ]]; then printf "services config"; exit 0; fi
if [[ "$*" == *"ps -a"* ]]; then printf "containers"; exit 0; fi
if [[ "$*" == *"logs --tail 200 web"* ]]; then printf "web log"; exit 0; fi
printf "worker unavailable" >&2
exit 1
`,
  );
  await chmod(join(bin, "docker"), 0o755);

  const result = await collectProjectInitializationDiagnostics(
    { worktree, launchError: "preview failed" },
    { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    { containerRuntime: createContainerRuntime("linux") },
  );

  assert.equal(result.setupLog, "setup failed");
  assert.equal(result.composeConfig, "services config");
  assert.equal(result.composePs, "containers");
  assert.equal(result.serviceLogs.web, "web log");
  assert.match(result.serviceLogs.worker, /worker unavailable/);
});

test("redacts secrets while retaining topology diagnostics", () => {
  const result = sanitizeProjectDiagnostic(
    [
      "API_URL: http://backend:3333",
      'DB_PASSWORD: "private value"',
      "AUTH_TOKEN=secret-token",
      '{"clientSecret":"json secret"}',
      "DATABASE_URL=mysql://user:password@database:3306/app",
      "Authorization: Bearer token-value",
    ].join("\n"),
  );

  assert.match(result, /API_URL: http:\/\/backend:3333/);
  assert.doesNotMatch(
    result,
    /private value|secret-token|json secret|user:password|token-value/,
  );
  assert.match(result, /DB_PASSWORD: \[REDACTED\]/);
});
