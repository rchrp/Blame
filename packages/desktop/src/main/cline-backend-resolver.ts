import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { AgentBackendConfig } from "@blame/agent-runtime";
import { setupPath } from "./host-tool-path.ts";
import { runtimeAgentClient } from "./runtime-agent.ts";
import { ensureRuntimeReady } from "./runtime-manager.ts";
import { runtimeHostPath, runtimeManagedPath } from "./workspace-runtime.ts";

export type AgentWorkspaceResolution = {
  backend: AgentBackendConfig;
  input: Record<string, unknown>;
};
type ResolverInput = {
  agentClient?: {
    clineHubEnsure(): Promise<{ authToken?: string; url?: string }>;
  };
  env?: NodeJS.ProcessEnv;
  ensureReady?: typeof ensureRuntimeReady;
  platform?: NodeJS.Platform;
};

const runtimeBackendMessage =
  "Cline runtime backend unavailable in BlameRuntime. Repair or reset the Blame runtime and try again.";

export async function resolveAgentWorkspaceInput<
  T extends Record<string, unknown>,
>(input: T, options: ResolverInput = {}) {
  const platform = options.platform ?? process.platform;
  const workspaceMode = explicitWorkspaceMode(input);
  const runtimeField = runtimeManagedWorkspaceField(input, platform);
  if (workspaceMode === "cloud-mirror") {
    if (runtimeField) {
      throw new Error(
        "This managed preview still uses a Lima/WSL worktree. Stop and requeue the story to create its native host worktree.",
      );
    }
    return localWorkspaceInput(input, platform);
  }
  if (workspaceMode === "local-container" && !runtimeField) {
    return localWorkspaceInput(input, platform);
  }
  if (!runtimeField) return localWorkspaceInput(input, platform);
  await (options.ensureReady ?? ensureRuntimeReady)(
    runtimeEnvironment(options, platform),
  );
  const hub = await ensureRuntimeClineHub(options, platform);
  const identity = runtimeHubBackendIdentity(platform, hub);
  return {
    ...runtimeNativeWorkspaceInput(input),
    backend: {
      mode: "remote",
      endpoint: identity.endpoint,
      authToken: identity.authToken,
      cwd: stringField(input.cwd),
      workspaceRoot: stringField(input.workspaceRoot),
      key: identity.key,
    },
  };
}

function explicitWorkspaceMode(input: Record<string, unknown>) {
  return input.workspaceMode === "local-container" ||
    input.workspaceMode === "cloud-mirror"
    ? input.workspaceMode
    : undefined;
}

export function localWorkspaceInput<T extends Record<string, unknown>>(
  input: T,
  platform: NodeJS.Platform = process.platform,
) {
  return {
    ...input,
    ...(typeof input.cwd === "string"
      ? { cwd: runtimeHostPath(input.cwd, platform) }
      : {}),
    ...(typeof input.workspaceRoot === "string"
      ? { workspaceRoot: runtimeHostPath(input.workspaceRoot, platform) }
      : {}),
    ...(typeof input.worktree === "string"
      ? { worktree: runtimeHostPath(input.worktree, platform) }
      : {}),
    ...(typeof input.repositoryRoot === "string"
      ? { repositoryRoot: runtimeHostPath(input.repositoryRoot, platform) }
      : {}),
    backend: { mode: "local", key: "local" },
  };
}

function runtimeNativeWorkspaceInput<T extends Record<string, unknown>>(
  input: T,
) {
  return {
    ...input,
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(typeof input.workspaceRoot === "string"
      ? { workspaceRoot: input.workspaceRoot }
      : {}),
    ...(typeof input.worktree === "string" ? { worktree: input.worktree } : {}),
    ...(typeof input.repositoryRoot === "string"
      ? { repositoryRoot: input.repositoryRoot }
      : {}),
  };
}

function runtimeManagedWorkspaceField(
  input: Record<string, unknown>,
  platform: NodeJS.Platform,
) {
  return ["cwd", "workspaceRoot", "worktree", "repositoryRoot"].find((key) => {
    const value = input[key];
    return typeof value === "string" && runtimeManagedPath(value, platform);
  });
}

async function ensureRuntimeClineHub(
  options: ResolverInput,
  platform: NodeJS.Platform,
) {
  try {
    const client =
      options.agentClient ??
      runtimeAgentClient({
        env: runtimeEnvironment(options, platform).env,
        platform,
      });
    const hub = await client.clineHubEnsure();
    if (!hub.url) throw new Error("Runtime Cline hub did not return a URL.");
    if ((platform === "win32" || platform === "darwin") && hub.url) {
      try {
        await preWarmRoute(runtimeHubHealthUrl(hub.url), platform);
      } catch (error) {
        // Ignore pre-warm errors
      }
    }
    return hub;
  } catch (error) {
    throw runtimeBackendUnavailable(error);
  }
}

export function runtimeHubHealthUrl(url: string) {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = parsed.pathname.replace(/\/hub\/?$/, "/health");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function runtimeHubBackendIdentity(
  platform: NodeJS.Platform,
  hub: { authToken?: string; url?: string },
) {
  if (!hub.url) throw new Error("Runtime Cline hub did not return a URL.");
  const endpoint = new URL(hub.url);
  const authToken =
    hub.authToken ?? endpoint.searchParams.get("authToken") ?? undefined;
  endpoint.searchParams.delete("authToken");
  endpoint.hash = "";
  const normalizedEndpoint = endpoint.toString();
  const authFingerprint = createHash("sha256")
    .update(authToken ?? "")
    .digest("hex")
    .slice(0, 16);
  return {
    authToken,
    endpoint: normalizedEndpoint,
    key: `runtime:${platform}:${normalizedEndpoint}:auth:${authFingerprint}`,
  };
}

export function retryableHubTransportError(error: unknown) {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";
  const message =
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : errorMessage(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return (
    name === "HubTransportError" &&
    ((typeof code === "string" &&
      [
        "hub_connect_failed",
        "hub_connect_timeout",
        "hub_connection_closed",
        "hub_connection_not_open",
      ].includes(code)) ||
      !message.trim() ||
      /hub connection closed/i.test(message) ||
      /hub_connection_closed/i.test(message) ||
      /\bcode=1006\b/i.test(message))
  );
}

export function refreshRuntimeBackendConnection<
  T extends Record<string, unknown>,
>(input: T, connectionId = randomUUID()) {
  const backend = input.backend;
  if (
    !backend ||
    typeof backend !== "object" ||
    !("mode" in backend) ||
    backend.mode !== "remote" ||
    !("key" in backend) ||
    typeof backend.key !== "string"
  ) {
    return input;
  }
  return {
    ...input,
    backend: {
      ...backend,
      key: `${backend.key}:connection:${connectionId}`,
    },
  };
}

function preWarmRoute(url: string, platform: NodeJS.Platform): Promise<void> {
  // IMPORTANT: stdio:'ignore' is required on Windows.
  // execFile/execFileAsync causes curl.exe to inherit the write-end of the
  // wsl.exe stdin pipe (bInheritHandles=TRUE when parent has open pipe handles).
  // When curl.exe exits it closes that inherited handle; if it was the last
  // writer the Python daemon receives EOF on stdin and exits cleanly (code 0).
  // spawn with stdio:'ignore' sets bInheritHandles=FALSE so curl.exe never
  // acquires any of the parent's pipe handles.
  const bin = platform === "win32" ? "curl.exe" : "curl";
  const maxTimeSeconds = platform === "win32" ? "35" : "2";
  const connectTimeoutSeconds = platform === "win32" ? "35" : "1";
  const killTimeoutMs = platform === "win32" ? 40_000 : 3_000;
  return new Promise<void>((resolve) => {
    try {
      const child = spawn(
        bin,
        [
          "--silent",
          "--max-time",
          maxTimeSeconds,
          "--connect-timeout",
          connectTimeoutSeconds,
          url,
        ],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, killTimeoutMs);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function runtimeEnvironment(options: ResolverInput, platform: NodeJS.Platform) {
  return {
    env: options.env ?? {
      ...process.env,
      PATH: setupPath({ platform }),
    },
    platform,
  };
}

function runtimeBackendUnavailable(error: unknown) {
  const next = new Error(`${runtimeBackendMessage}\n${errorMessage(error)}`);
  Object.assign(next, { cause: error });
  return next;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
