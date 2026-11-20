import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceCallHandlers } from "./workspace.js";

test("the host's calls with no agent: Open PR's check, the MCP sign-ins", async () => {
  const root = mkdtempSync(join(tmpdir(), "blame-workspace-calls-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/app.git"],
      { cwd: root },
    );
    const gh: string[][] = [];
    const opened: string[] = [];
    const calls = workspaceCallHandlers({
      gh: async (_cwd, args) => {
        gh.push(args);
        return "";
      },
      openAuthorization: async (url) => {
        opened.push(url);
      },
    });
    assert.equal(
      (await calls.pullRequestAvailability({ repositoryRoot: root })).status,
      "available",
    );
    assert.deepEqual(gh[0]!.slice(0, 2), ["auth", "status"]);
    await assert.rejects(
      calls.pullRequestAvailability({ repositoryRoot: "relative" }),
      /absolute path/,
    );

    const settings = join(root, "mcp.json");
    writeFileSync(
      settings,
      JSON.stringify({
        mcpServers: {
          docs: { type: "streamableHttp", url: "https://mcp.example/mcp" },
          local: { command: "node", args: ["server.js"] },
        },
      }),
    );
    const statuses = await calls.mcpOAuthStatuses({ filePath: settings });
    assert.deepEqual(
      statuses.map(({ serverName, supported }) => [serverName, supported]),
      [
        ["docs", true],
        ["local", false],
      ],
    );
    assert.equal(
      await calls.mcpOAuthClear({ filePath: settings, serverName: "docs" }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
