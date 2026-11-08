import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import {
  AgentGithubAccessSettings,
  grantSessionGithubAccess,
  grantedGithubTokens,
  readHostGithubToken,
  sessionGithubMcpServer,
  withSessionCommandCredentials,
  type AgentGithubAccessLevel,
  type HostGithubToken,
} from "./agent-github-access.ts";

const token = "gho_SessionToken0123456789abcdefABCDEFGH";
const managedBackend = { mode: "remote", endpoint: "ws://127.0.0.1:1" };

test("GitHub access is off by default and kept per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-github-access-"));
  try {
    const file = join(root, "agent-github-access.json");
    const settings = new AgentGithubAccessSettings(file);
    assert.equal(await settings.level("project-a"), "off");
    assert.equal(await settings.level(undefined), "off");
    await settings.setLevel("project-a", "read");
    await settings.setLevel("project-b", "write");
    assert.equal(await settings.level("project-c"), "off");
    assert.equal(await new AgentGithubAccessSettings(file).level("project-a"), "read");
    assert.equal(await new AgentGithubAccessSettings(file).level("project-b"), "write");
    await settings.setLevel("project-a", "off");
    assert.equal(await new AgentGithubAccessSettings(file).level("project-a"), "off");
    await assert.rejects(settings.setLevel("../x", "read"), /Invalid project id/u);
    await assert.rejects(settings.setLevel("project-a", "admin"), /Invalid GitHub access level/u);
    assert.equal(await settings.level("project-a"), "off");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a project US-073 turned access on for keeps read and write access", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-github-access-"));
  try {
    const file = join(root, "agent-github-access.json");
    await writeFile(file, JSON.stringify({ projects: ["project-a"] }));
    const settings = new AgentGithubAccessSettings(file);
    assert.equal(await settings.level("project-a"), "write");
    await settings.setLevel("project-b", "read");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      projects: { "project-a": "write", "project-b": "read" },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the host token comes from gh auth token, with a clear reason when there is none", async () => {
  const calls: string[][] = [];
  assert.deepEqual(
    await readHostGithubToken(async (args) => {
      calls.push(args);
      return { stdout: `${token}\n` };
    }),
    { token },
  );
  assert.deepEqual(calls, [["auth", "token"]]);

  const missing = await readHostGithubToken(async () => {
    throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  });
  assert.match(unavailable(missing), /isn't installed/u);

  const signedOut = await readHostGithubToken(async () => {
    throw Object.assign(new Error("no oauth token found"), { code: 1 });
  });
  assert.match(unavailable(signedOut), /isn't signed in.*gh auth login/u);
  assert.match(unavailable(await readHostGithubToken(async () => ({ stdout: "\n" }))), /isn't signed in/u);
});

test("a Local Container session's requests carry GH_TOKEN only when its project allows read and write", async () => {
  let reads = 0;
  const dependencies = (level: AgentGithubAccessLevel, result: HostGithubToken = { token }) => ({
    level: async () => level,
    readToken: async () => {
      reads += 1;
      return result;
    },
  });
  const session = { sessionId: "session-on", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend };

  assert.deepEqual(await grantSessionGithubAccess(session, dependencies("write")), {});
  assert.deepEqual(credentials("session-on"), { githubToken: token });
  assert.deepEqual(credentials("another-session"), {});
  assert.deepEqual(grantedGithubTokens(), [token]);
  // Read and write is US-073's access: no GitHub MCP server.
  assert.equal(sessionGithubMcpServer("session-on"), undefined);
  // What the agent process sends is replaced by what the desktop granted.
  assert.deepEqual(
    withSessionCommandCredentials({ ...request("another-session"), commandCredentials: { githubToken: "gho_forged" } })
      .commandCredentials,
    {},
  );

  // Restarting the session with access off revokes the token, without reading gh.
  reads = 0;
  assert.deepEqual(await grantSessionGithubAccess(session, dependencies("off")), {});
  assert.deepEqual(credentials("session-on"), {});
  assert.deepEqual(grantedGithubTokens(), []);
  assert.equal(reads, 0);

  // Cloud and Direct sessions never read the host token.
  await grantSessionGithubAccess({ ...session, workspaceMode: "cloud-mirror" }, dependencies("write"));
  await grantSessionGithubAccess({ ...session, workspaceMode: "direct", backend: undefined }, dependencies("read"));
  assert.equal(reads, 0);
  assert.deepEqual(credentials("session-on"), {});
});

test("a read-only session's token goes to GitHub's MCP server only, never to its commands", async () => {
  const session = { sessionId: "session-read", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend };
  assert.deepEqual(
    await grantSessionGithubAccess(session, { level: async () => "read", readToken: async () => ({ token }) }),
    {},
  );
  // Neither the granted token nor one the agent process forged reaches run_task.
  assert.deepEqual(credentials("session-read"), {});
  assert.deepEqual(
    withSessionCommandCredentials({ ...request("session-read"), commandCredentials: { githubToken: token } })
      .commandCredentials,
    {},
  );
  assert.deepEqual(sessionGithubMcpServer("session-read"), {
    url: "https://api.githubcopilot.com/mcp/",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-MCP-Readonly": "true",
      "X-MCP-Toolsets": "context,repos,issues,pull_requests,actions",
    },
  });
  assert.equal(sessionGithubMcpServer("another-session"), undefined);
  assert.deepEqual(grantedGithubTokens(), [token]);

  await grantSessionGithubAccess(session, { level: async () => "off", readToken: async () => ({ token }) });
  assert.equal(sessionGithubMcpServer("session-read"), undefined);
});

test("a session starts without GitHub access, and says why, when gh has no token", async () => {
  const result = await grantSessionGithubAccess(
    { sessionId: "session-no-gh", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend },
    { level: async () => "read", readToken: async () => ({ unavailable: "gh isn't signed in" }) },
  );
  assert.deepEqual(result, { notice: "gh isn't signed in" });
  assert.deepEqual(credentials("session-no-gh"), {});
  assert.equal(sessionGithubMcpServer("session-no-gh"), undefined);
});

function credentials(sessionId: string) {
  return withSessionCommandCredentials(request(sessionId)).commandCredentials;
}

function request(sessionId: string): LightWorkspaceExecutionRequest {
  return {
    execution: { backendMode: "remote", workspaceMode: "local-container" },
    input: { kind: "command", command: "gh pr list" },
    taskContract: { session_id: sessionId },
    tool: "run_task",
    workspaceRoot: "/home/blame/.local/share/blame/runtime/worktrees/project/story-US-1",
  };
}

function unavailable(result: HostGithubToken) {
  assert.ok("unavailable" in result, JSON.stringify(result));
  return result.unavailable;
}
