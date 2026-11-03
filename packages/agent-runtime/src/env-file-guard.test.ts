import assert from "node:assert/strict";
import test from "node:test";
import { developerEnvFile, envFileGuardExtension } from "./env-file-guard.js";

test("keeps analysis agents out of the developer's env files, not the examples", async () => {
  assert.equal(developerEnvFile("/repo/.env"), true);
  assert.equal(developerEnvFile("/repo/apps/api/.env.local"), true);
  assert.equal(developerEnvFile("C:\\repo\\.env.production"), true);
  assert.equal(developerEnvFile("/repo/.env.example"), false);
  assert.equal(developerEnvFile("/repo/src/env.ts"), false);
  const hooks = (
    envFileGuardExtension() as unknown as {
      hooks: {
        beforeTool(context: {
          tool: { name: string };
          input: unknown;
        }): unknown;
      };
    }
  ).hooks;
  const blocked = (await hooks.beforeTool({
    tool: { name: "read_files" },
    input: { files: [{ path: "/repo/package.json" }, { path: "/repo/.env" }] },
  })) as { skip?: boolean; reason?: string };
  assert.equal(blocked.skip, true);
  assert.match(blocked.reason!, /\/repo\/\.env out of this analysis/);
  assert.equal(
    await hooks.beforeTool({
      tool: { name: "read_files" },
      input: { files: [{ path: "/repo/.env.example" }] },
    }),
    undefined,
  );
  assert.equal(
    await hooks.beforeTool({
      tool: { name: "search_codebase" },
      input: { query: ".env" },
    }),
    undefined,
  );
});
