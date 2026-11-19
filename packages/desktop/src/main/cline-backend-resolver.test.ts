import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRpcError,
  agentRpcResponseError,
} from "./agent-runtime-process-protocol.ts";
import {
  localWorkspaceInput,
  refreshRuntimeBackendConnection,
  resolveAgentWorkspaceInput,
  retryableHubTransportError,
  runtimeHubBackendIdentity,
  runtimeHubHealthUrl,
} from "./cline-backend-resolver.ts";

test("builds the Cline health URL with or without an auth query", () => {
  assert.equal(
    runtimeHubHealthUrl("ws://127.0.0.1:25463/hub"),
    "http://127.0.0.1:25463/health",
  );
  assert.equal(
    runtimeHubHealthUrl("wss://runtime.test/hub?authToken=secret"),
    "https://runtime.test/health",
  );
});
test("resolves Windows runtime worktrees to a remote Cline backend", async () => {
  const input = {
    cwd: "/home/blame/.local/share/blame/runtime/worktrees/repo/story",
    workspaceRoot:
      "/home/blame/.local/share/blame/runtime/worktrees/repo/story",
  };

  const resolved = await resolveAgentWorkspaceInput(input, {
    agentClient: {
      clineHubEnsure: async () => ({
        authToken: "secret",
        url: "ws://127.0.0.1:25463/hub",
      }),
    },
    platform: "win32",
  });

  assert.equal(resolved.cwd, input.cwd);
  assert.equal(resolved.workspaceRoot, input.workspaceRoot);
  assert.deepEqual(resolved.backend, {
    authToken: "secret",
    cwd: input.cwd,
    endpoint: "ws://127.0.0.1:25463/hub",
    key: runtimeHubBackendIdentity("win32", {
      authToken: "secret",
      url: "ws://127.0.0.1:25463/hub",
    }).key,
    mode: "remote",
    workspaceRoot: input.workspaceRoot,
  });
  assert.equal(resolved.backend.key.includes("secret"), false);
});

test("resolves macOS runtime worktrees to a remote Cline backend", async () => {
  const cwd = "/home/blame/.local/share/blame/runtime/worktrees/repo/story";

  const resolved = await resolveAgentWorkspaceInput(
    { cwd, workspaceRoot: cwd },
    {
      agentClient: {
        clineHubEnsure: async () => ({ url: "ws://127.0.0.1:25463/hub" }),
      },
      platform: "darwin",
    },
  );

  assert.equal(resolved.cwd, cwd);
  assert.equal(resolved.backend.mode, "remote");
});

test("keeps legacy macOS shared worktrees connected to the remote backend", async () => {
  const cwd =
    "/Users/dev/Library/Application Support/Blame/runtime/worktrees/repo/story";

  const resolved = await resolveAgentWorkspaceInput(
    { cwd, workspaceRoot: cwd },
    {
      agentClient: {
        clineHubEnsure: async () => ({ url: "ws://127.0.0.1:25463/hub" }),
      },
      platform: "darwin",
    },
  );

  assert.equal(resolved.cwd, cwd);
  assert.equal(resolved.backend.mode, "remote");
});

test("resolves Linux and unmanaged paths to local Cline backend", async () => {
  const input = {
    cwd: "/home/dev/project",
    workspaceRoot: "/home/dev/project",
  };

  assert.deepEqual(
    await resolveAgentWorkspaceInput(input, { platform: "linux" }),
    {
      ...input,
      backend: { mode: "local", key: "local" },
    },
  );
  assert.deepEqual(localWorkspaceInput(input, "win32"), {
    ...input,
    backend: { mode: "local", key: "local" },
  });
});

test("keeps an explicit cloud mirror on the native Cline backend", async () => {
  const input = {
    cwd: "/Users/dev/Library/Application Support/Blame/cloud/worktrees/repo/story",
    workspaceMode: "cloud-mirror" as const,
    workspaceRoot:
      "/Users/dev/Library/Application Support/Blame/cloud/worktrees/repo/story",
  };

  assert.deepEqual(
    await resolveAgentWorkspaceInput(input, { platform: "darwin" }),
    { ...input, backend: { mode: "local", key: "local" } },
  );
});

test("rejects a cloud mirror that still points inside Lima or WSL", async () => {
  await assert.rejects(
    resolveAgentWorkspaceInput(
      {
        cwd: "/home/blame/.local/share/blame/runtime/worktrees/repo/story",
        workspaceMode: "cloud-mirror",
        workspaceRoot:
          "/home/blame/.local/share/blame/runtime/worktrees/repo/story",
      },
      { platform: "darwin" },
    ),
    /Stop and requeue the story/,
  );
});

test("normalizes runtime hub auth while changing identity after a hub restart", () => {
  const separateAuth = runtimeHubBackendIdentity("darwin", {
    authToken: "first-token",
    url: "ws://127.0.0.1:25463/hub",
  });
  const queryAuth = runtimeHubBackendIdentity("darwin", {
    url: "ws://127.0.0.1:25463/hub?authToken=first-token",
  });
  const restartedHub = runtimeHubBackendIdentity("darwin", {
    authToken: "second-token",
    url: "ws://127.0.0.1:25463/hub",
  });

  assert.deepEqual(queryAuth, separateAuth);
  assert.equal(separateAuth.endpoint, "ws://127.0.0.1:25463/hub");
  assert.equal(separateAuth.key.includes("first-token"), false);
  assert.notEqual(restartedHub.key, separateAuth.key);
});

test("retries only abnormal Cline hub connection closures", () => {
  const closed = new Error("Hub connection closed (code=1006)");
  closed.name = "HubTransportError";
  assert.equal(retryableHubTransportError(closed), true);

  const provider = new Error("Provider returned 429");
  provider.name = "HubTransportError";
  assert.equal(retryableHubTransportError(provider), false);
  assert.equal(
    retryableHubTransportError(new Error("Hub connection closed (code=1006)")),
    false,
  );
});

test("forces a fresh Cline core only for a retried remote connection", () => {
  const remote = {
    backend: {
      key: "runtime:darwin:hub",
      mode: "remote",
    },
    cwd: "/worktree",
  };
  assert.deepEqual(refreshRuntimeBackendConnection(remote, "retry-1"), {
    ...remote,
    backend: {
      ...remote.backend,
      key: "runtime:darwin:hub:connection:retry-1",
    },
  });

  const local = { backend: { key: "local", mode: "local" }, cwd: "/project" };
  assert.equal(refreshRuntimeBackendConnection(local, "retry-1"), local);
});

test("preserves hub connection error codes across RPC even with an empty SDK message", () => {
  for (const code of [
    "hub_connect_failed",
    "hub_connect_timeout",
    "hub_connection_closed",
    "hub_connection_not_open",
  ]) {
    const original = Object.assign(new Error(""), {
      name: "HubTransportError",
      code,
    });
    const serialized = JSON.parse(JSON.stringify(agentRpcError(original)));
    const restored = agentRpcResponseError(serialized);
    assert.equal(serialized.code, code);
    assert.match(restored.message, /Unable to connect to the agent hub/);
    assert.equal(retryableHubTransportError(restored), true);
  }
  assert.equal(
    retryableHubTransportError({ name: "HubTransportError", message: "" }),
    true,
  );
  const timeout = Object.assign(
    new Error("Hub command session.create timed out"),
    {
      name: "HubCommandError",
      code: "hub_command_timeout",
    },
  );
  assert.equal(
    retryableHubTransportError(agentRpcResponseError(agentRpcError(timeout))),
    false,
  );
});
