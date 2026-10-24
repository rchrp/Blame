import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  collectProjectInitializationDiagnostics,
  sanitizeProjectDiagnostic,
} from "./project-initialization-diagnostics.ts";

test("collects compose configuration, status, and every service log", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-diagnostics-"));
  const worktree = join(root, "worktree");
  await mkdir(join(worktree, ".blame", "logs"), { recursive: true });
  await writeFile(
    join(worktree, ".blame", "logs", "setup.log"),
    "setup failed",
  );
  const outputs: Record<
    string,
    { exitCode: number; stdout: string; stderr: string }
  > = {
    "config --services": { exitCode: 0, stdout: "web\nworker\n", stderr: "" },
    config: { exitCode: 0, stdout: "services config", stderr: "" },
    "ps --all": { exitCode: 0, stdout: "containers", stderr: "" },
    "logs --tail 200 web": { exitCode: 0, stdout: "web log", stderr: "" },
  };

  const result = await collectProjectInitializationDiagnostics(
    { worktree, launchError: "preview failed" },
    process.env,
    {
      compose: async (args) =>
        outputs[args.join(" ")] ?? {
          exitCode: 1,
          stdout: "",
          stderr: "worker unavailable",
        },
    },
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
