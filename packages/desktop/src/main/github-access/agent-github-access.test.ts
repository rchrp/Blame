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
  requestCloudGithubToken,
  sessionCommandCredentials,
  sessionGithubMcpServer,
  withSessionCommandCredentials,
  type AgentGithubAccessLevel,
  type CloudGithubTokenRequest,
  type CloudGithubTokenResult,
  type HostGithubToken,
} from "./agent-github-access.ts";

const token = "gho_SessionToken0123456789abcdefABCDEFGH";
const managedBackend = { mode: "remote", endpoint: "ws://127.0.0.1:1" };
const apiConnection = { url: "https://api.blame.so/api/v1", token: "blame-session" };
const noCloudToken = async (): Promise<CloudGithubTokenResult> => {
  throw new Error("A Local Container session never asks the API for a token");
};

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
    cloudToken: noCloudToken,
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

  // Direct sessions never read the host token.
  await grantSessionGithubAccess({ ...session, workspaceMode: "direct", backend: undefined }, dependencies("read"));
  assert.equal(reads, 0);
  assert.deepEqual(credentials("session-on"), {});
});

test("a read-only session's token goes to GitHub's MCP server only, never to its commands", async () => {
  const session = { sessionId: "session-read", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend };
  assert.deepEqual(
    await grantSessionGithubAccess(session, { level: async () => "read", readToken: async () => ({ token }), cloudToken: noCloudToken }),
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

  await grantSessionGithubAccess(session, { level: async () => "off", readToken: async () => ({ token }), cloudToken: noCloudToken });
  assert.equal(sessionGithubMcpServer("session-read"), undefined);
});

test("a session starts without GitHub access, and says why, when gh has no token", async () => {
  const result = await grantSessionGithubAccess(
    { sessionId: "session-no-gh", projectId: "project-a", workspaceMode: "local-container", backend: managedBackend },
    { level: async () => "read", readToken: async () => ({ unavailable: "gh isn't signed in" }), cloudToken: noCloudToken },
  );
  assert.deepEqual(result, { notice: "gh isn't signed in" });
  assert.deepEqual(credentials("session-no-gh"), {});
  assert.equal(sessionGithubMcpServer("session-no-gh"), undefined);
});

test("each workspace mode gets its own credentials: App token in cloud, MCP in local read, GH_TOKEN in local write", async () => {
  const appToken = "ghs_cloud-app-token";
  const dependencies = (level: AgentGithubAccessLevel) => ({
    level: async () => level,
    readToken: async (): Promise<HostGithubToken> => ({ token }),
    cloudToken: async () => ({ token: appToken, expiresAt: Date.now() + 60 * 60_000 }),
  });
  const local = { projectId: "project-a", workspaceMode: "local-container", backend: managedBackend };
  const cloud = { sessionId: "mode-cloud", projectId: "project-a", workspaceMode: "cloud-mirror", apiConnection };

  await grantSessionGithubAccess(cloud, dependencies("write"));
  await grantSessionGithubAccess({ ...local, sessionId: "mode-read" }, dependencies("read"));
  await grantSessionGithubAccess({ ...local, sessionId: "mode-write" }, dependencies("write"));

  // Cloud: the App token through sessionCommandCredentials, never the host's.
  assert.deepEqual(await sessionCommandCredentials("mode-cloud"), { githubToken: appToken });
  assert.deepEqual(credentials("mode-cloud"), {});
  assert.equal(sessionGithubMcpServer("mode-cloud"), undefined);
  // Local read: an MCP server, no GH_TOKEN.
  assert.equal(sessionGithubMcpServer("mode-read")?.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(credentials("mode-read"), {});
  assert.deepEqual(await sessionCommandCredentials("mode-read"), {});
  // Local write: GH_TOKEN, no MCP server.
  assert.deepEqual(credentials("mode-write"), { githubToken: token });
  assert.equal(sessionGithubMcpServer("mode-write"), undefined);
  // Log redaction knows the local and the cloud tokens.
  assert.deepEqual(new Set(grantedGithubTokens()), new Set([token, appToken]));

  for (const sessionId of ["mode-read", "mode-write"])
    await grantSessionGithubAccess({ ...local, sessionId }, dependencies("off"));
  await grantSessionGithubAccess(cloud, dependencies("off"));
  assert.deepEqual(grantedGithubTokens(), []);
});

test("a cloud session's commands get the API's repository token, renewed before it expires, never the host's", async () => {
  const requests: CloudGithubTokenRequest[] = [];
  const issued = [
    // Expires within the renewal margin: the first command renews it.
    { token: "repository-token-first", expiresAt: Date.now() + 5 * 60_000 },
    { token: "repository-token-renewed", expiresAt: Date.now() + 60 * 60_000 },
  ];
  let hostReads = 0;
  const dependencies = (level: AgentGithubAccessLevel) => ({
    level: async () => level,
    readToken: async (): Promise<HostGithubToken> => {
      hostReads += 1;
      return { token };
    },
    cloudToken: async (request: CloudGithubTokenRequest) => {
      requests.push(request);
      return issued[Math.min(requests.length - 1, issued.length - 1)]!;
    },
  });
  const session = { sessionId: "cloud-session", projectId: "project-a", workspaceMode: "cloud-mirror", apiConnection };

  assert.deepEqual(await grantSessionGithubAccess(session, dependencies("write")), {});
  assert.deepEqual(requests, [{ apiConnection, projectId: "project-a" }]);
  assert.deepEqual(await sessionCommandCredentials("cloud-session"), { githubToken: "repository-token-renewed" });
  assert.equal(requests.length, 2);
  // Valid for long enough: the next command reuses it.
  assert.deepEqual(await sessionCommandCredentials("cloud-session"), { githubToken: "repository-token-renewed" });
  assert.equal(requests.length, 2);
  assert.deepEqual(await sessionCommandCredentials("another-session"), {});
  assert.ok(grantedGithubTokens().includes("repository-token-renewed"));
  assert.equal(hostReads, 0);

  // Restarting with access off revokes it without asking the API.
  assert.deepEqual(await grantSessionGithubAccess(session, dependencies("off")), {});
  assert.deepEqual(await sessionCommandCredentials("cloud-session"), {});
  assert.equal(requests.length, 2);
  assert.ok(!grantedGithubTokens().includes("repository-token-renewed"));
});

test("a cloud session starts without GitHub access, and says why, when the API issues no token", async () => {
  const result = await grantSessionGithubAccess(
    { sessionId: "cloud-refused", projectId: "project-a", workspaceMode: "cloud-mirror", apiConnection },
    {
      level: async () => "write",
      readToken: async () => ({ token }),
      cloudToken: async () => ({ unavailable: "Link this project to a GitHub repository first." }),
    },
  );
  assert.deepEqual(result, { notice: "Link this project to a GitHub repository first." });
  assert.deepEqual(await sessionCommandCredentials("cloud-refused"), {});
});

test("the cloud token is asked of the project's agent-token endpoint with the session's account", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const respond = (response: Response): typeof fetch => async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  };
  const request = { apiConnection, projectId: "project-a" };

  const result = await requestCloudGithubToken(request, {
    packaged: true,
    fetcher: respond(Response.json({ token: "ghs_repository", expiresAt, repository: "acme/web" })),
  });
  assert.deepEqual(result, { token: "ghs_repository", expiresAt: Date.parse(expiresAt) });
  assert.equal(calls[0]!.url, "https://api.blame.so/api/v1/projects/project-a/github/agent-token");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer blame-session");

  const refused = await requestCloudGithubToken(request, {
    packaged: true,
    fetcher: respond(
      Response.json({ errors: [{ message: "GitHub access for the agent is turned off for this project." }] }, { status: 403 }),
    ),
  });
  assert.match("unavailable" in refused ? refused.unavailable : "", /turned off for this project/u);

  calls.length = 0;
  const elsewhere = await requestCloudGithubToken(
    { ...request, apiConnection: { ...apiConnection, url: "https://attacker.example/api/v1" } },
    { packaged: true, fetcher: respond(Response.json({})) },
  );
  assert.ok("unavailable" in elsewhere);
  assert.equal(calls.length, 0);
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
