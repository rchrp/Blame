import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getProviderCollectionSync, type ModelInfo } from "@cline/llms";

import { saveLocalProviderCredential } from "../cloud-api.js";
import type { AgentBackendConfig, ConnectClaudeCodeInput } from "../types.js";
import { ClaudeCodeBridge } from "./claude-code-bridge.js";
import { readClaudeCodeStatus } from "./claude-code-cli.js";
import { claudeCodeEfforts } from "./claude-code-protocol.js";

export const claudeCodeProviderId = "claude-code";

/** Where the VM-hosted Cline hub reaches the Mac's loopback interface. */
const limaHostAddress = "host.lima.internal";

let bridge: Promise<ClaudeCodeBridge> | undefined;

export function claudeCodeStatus() {
  return readClaudeCodeStatus();
}

/** Saves the connection once Claude Code is installed and signed in here. */
export async function connectClaudeCode(input: ConnectClaudeCodeInput) {
  const status = await readClaudeCodeStatus();
  if (!status.installed)
    throw new Error("Claude Code is not installed on this computer.");
  if (!status.loggedIn)
    throw new Error(
      "Claude Code is installed but not signed in. Run `claude`, sign in, then try again.",
    );
  const credential = await saveLocalProviderCredential(input.apiConnection, {
    providerId: claudeCodeProviderId,
    label: input.label?.trim() || undefined,
    accountId: status.email ?? null,
  });
  return { credential, status };
}

export function isClaudeCodeProvider(providerId: string | undefined) {
  return providerId === claudeCodeProviderId;
}

/**
 * Points a Claude Code credential at the local bridge. The bridge key is
 * scoped to one session or operation so each conversation keeps its own
 * Claude Code process.
 */
export async function claudeCodeCredential<
  T extends { apiKey: string; baseUrl: string | null; providerId: string },
>(
  credential: T,
  input: {
    backend?: AgentBackendConfig;
    reasoningEffort?: string;
    scope?: string;
  },
): Promise<T> {
  if (!isClaudeCodeProvider(credential.providerId)) return credential;
  const host = bridgeHost(input.backend);
  const active = await claudeCodeBridge();
  return {
    ...credential,
    apiKey: active.token(input.scope ?? `op:${randomUUID()}`),
    baseUrl: active.baseUrl(host, claudeCodeEffort(input.reasoningEffort)),
  };
}

/**
 * Cline maps efforts for the Claude Code aliases onto a fixed thinking
 * budget, so Blame's pick goes to Claude Code directly.
 */
function claudeCodeEffort(reasoningEffort: string | undefined) {
  if (reasoningEffort === "none") return "low";
  return claudeCodeEfforts.find((effort) => effort === reasoningEffort);
}

/**
 * Cline reaches the bridge through its Anthropic provider. The Claude Code
 * model aliases keep their catalog limits and cost nothing per token, since
 * usage counts against the user's subscription.
 */
export function claudeCodeModelConfig<
  T extends {
    providerId: string;
    modelId: string;
    knownModels?: Record<string, ModelInfo>;
  },
>(config: T): T {
  if (!isClaudeCodeProvider(config.providerId)) return config;
  const model = getProviderCollectionSync(claudeCodeProviderId)?.models[
    config.modelId
  ];
  return {
    ...config,
    providerId: "anthropic",
    knownModels: {
      ...config.knownModels,
      ...(model
        ? {
            [config.modelId]: {
              ...model,
              pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          }
        : {}),
    },
  };
}

export async function closeClaudeCodeBridge() {
  const current = bridge;
  bridge = undefined;
  await (await current?.catch(() => undefined))?.close();
}

function claudeCodeBridge() {
  bridge ??= ClaudeCodeBridge.start({
    stateDirectory:
      process.env.BLAME_CLAUDE_CODE_STATE_DIR?.trim() ||
      join(tmpdir(), "blame-claude-code"),
  }).catch((error) => {
    bridge = undefined;
    throw error;
  });
  return bridge;
}

function bridgeHost(backend: AgentBackendConfig | undefined) {
  if (backend?.mode !== "remote") return "127.0.0.1";
  if (process.platform === "darwin") return limaHostAddress;
  throw new Error(
    "Claude Code is not available yet for stories that run in the Windows runtime. Use Quick Chat, or pick another provider for this story.",
  );
}
