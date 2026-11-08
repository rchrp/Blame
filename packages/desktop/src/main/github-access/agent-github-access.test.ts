import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import {
  AgentGithubAccessSettings,
  grantSessionGithubAccess,
  grantedGithubTokens,
  readHostGithubToken,
  withSessionCommandCredentials,
  type HostGithubToken,
} from "./agent-github-access.ts";

const token = "gho_SessionToken0123456789abcdefABCDEFGH";
const managedBackend = { mode: "remote", endpoint: "ws://127.0.0.1:1" };

test("GitHub access is off by default and kept per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-github-access-"));
  try {
    const file = join(root, "agent-github-access.json");
    const settings = new AgentGithubAccessSettings(file);
    assert.equal(await settings.enabled("project-a"), false);
    assert.equal(await settings.enabled(undefined), false);
    await settings.setEnabled("project-a", true);
    assert.equal(await settings.enabled("project-b"), false);
    assert.equal(await new AgentGithubAccessSettings(file).enabled("project-a"), true);
    await settings.setEnabled("project-a", false);
    assert.equal(await new AgentGithubAccessSettings(file).enabled("project-a"), false);
    await assert.rejects(settings.setEnabled("../x", true), /Invalid project id/u);
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

test("a Local Container session's requests carry GH_TOKEN only when its project turned access on", async () => {
  let reads = 0;
  const dependencies = (enabled: boolean, result: HostGithubToken = { token }) => ({
    enabled: async () => enabled,
    readToken: async () => {
      reads += 1;
      return result;
    },
  });
  const session = { sessionId: "session-on", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend };

  assert.deepEqual(await grantSessionGithubAccess(session, dependencies(true)), {});
  assert.deepEqual(credentials("session-on"), { githubToken: token });
  assert.deepEqual(credentials("another-session"), {});
  assert.deepEqual(grantedGithubTokens(), [token]);
  // What the agent process sends is replaced by what the desktop granted.
  assert.deepEqual(
    withSessionCommandCredentials({ ...request("another-session"), commandCredentials: { githubToken: "gho_forged" } })
      .commandCredentials,
    {},
  );

  // Restarting the session with access off revokes the token, without reading gh.
  reads = 0;
  assert.deepEqual(await grantSessionGithubAccess(session, dependencies(false)), {});
  assert.deepEqual(credentials("session-on"), {});
  assert.deepEqual(grantedGithubTokens(), []);
  assert.equal(reads, 0);

  // Cloud and Direct sessions never read the host token.
  await grantSessionGithubAccess({ ...session, workspaceMode: "cloud-mirror" }, dependencies(true));
  await grantSessionGithubAccess({ ...session, workspaceMode: "direct", backend: undefined }, dependencies(true));
  assert.equal(reads, 0);
  assert.deepEqual(credentials("session-on"), {});
});

test("a session starts without GitHub access, and says why, when gh has no token", async () => {
  const result = await grantSessionGithubAccess(
    { sessionId: "session-no-gh", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend },
    { enabled: async () => true, readToken: async () => ({ unavailable: "gh isn't signed in" }) },
  );
  assert.deepEqual(result, { notice: "gh isn't signed in" });
  assert.deepEqual(credentials("session-no-gh"), {});
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
