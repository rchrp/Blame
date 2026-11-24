// The engine host's pure helpers (`host.ts`): what an attachment is to the
// providers, configs compared as JSON, the task a call names, the session a
// conversation's tools are listed for, and a credential as the VM sees it.

import type { Credential, EngineCommand } from "@blame/engine-client";
import type { EngineHostMethod, EngineSessionSettings } from "./protocol.js";
import { engineTaskMethods } from "./task-protocol.js";
import {
  previewRuntimeContext,
  type ConversationToolSession,
} from "./tools/index.js";

const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const textTypes =
  /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|toml|x-sh|sql)$)/;

/** What the providers can read: images, PDFs and text, nothing else. */
export function attachmentKind(
  mediaType: string,
): "image" | "document" | undefined {
  if (imageTypes.has(mediaType)) return "image";
  if (mediaType === "application/pdf" || textTypes.test(mediaType))
    return "document";
  return undefined;
}

/** Equal as JSON, whatever the order of object keys (the engine's differs). */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The id of the task a call runs, when the renderer named it to follow it. */
export function announcedTask(method: EngineHostMethod, input: unknown) {
  if (!(engineTaskMethods as readonly string[]).includes(method)) return;
  const task = (input as { task?: unknown } | undefined)?.task;
  return typeof task === "string" && task ? task : undefined;
}

/** What the conversation's own client tools are listed for. */
export function conversationToolSession(
  session: string,
  settings: EngineSessionSettings,
  workspaceRoot: string,
): ConversationToolSession {
  switch (settings.purpose) {
    case "development-story": {
      const story = settings.settings;
      return {
        session,
        kind: "story",
        workspaceRoot,
        projectId: story.projectId,
        storyId: story.storyId,
        preview: previewRuntimeContext({
          projectInitialization: story.projectInitialization,
          previewDevtoolsScope: story.previewDevtoolsScope,
          projectId: story.projectId,
          storyId: story.storyId,
          workspaceMode: story.workspaceMode,
          workspaceRoot,
        }),
        ...(story.projectInitialization
          ? {
              previewRepair: {
                model: story.model,
                projectId: story.projectId,
                initialization: story.projectInitialization,
              },
            }
          : {}),
      };
    }
    case "new-project":
      return { session, kind: "new-project", workspaceRoot };
    case "orchestrator":
      return {
        session,
        kind: "orchestrator",
        workspaceRoot,
        projectId: settings.settings.projectId,
        epicId: settings.settings.epicId,
      };
    case "quick-chat":
      return {
        session,
        kind: "quick-chat",
        workspaceRoot,
        projectId: settings.settings.projectId,
      };
  }
}

/** What the desktop tells the host about its runtime VM. */
export type VmEngineOptions = {
  /**
   * Installs the engine in the VM when missing or out of date, then gives
   * the command that runs `blame-engine serve` there over stdio.
   */
  prepare(): Promise<EngineCommand>;
  /** Folders that live in the VM: a task whose workspace is under one runs there. */
  workspaceRoots: readonly string[];
  /**
   * How the VM reaches this computer (`host.lima.internal`): a credential's
   * local endpoint (a local model, the Claude Code bridge) is rewritten to
   * it, since the VM's own localhost is not this computer's.
   */
  hostAlias?: string;
  /** A private socket in WSL that reaches the host's Claude Code bridge. */
  claudeCodeSocket?(baseUrl: string): Promise<string>;
};

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A credential as the VM's engine can use it: local endpoints point at this computer. */
export function vmCredential(
  credential: Credential,
  vm: Pick<VmEngineOptions, "hostAlias">,
): Credential {
  if (!vm.hostAlias || !("base_url" in credential) || !credential.base_url)
    return credential;
  let url: URL;
  try {
    url = new URL(credential.base_url);
  } catch {
    return credential;
  }
  if (!loopbackHosts.has(url.hostname) && !url.hostname.endsWith(".localhost"))
    return credential;
  url.hostname = vm.hostAlias;
  return { ...credential, base_url: url.toString().replace(/\/$/, "") };
}

export async function vmProviderCredential(
  provider: string,
  credential: Credential,
  vm: Pick<VmEngineOptions, "hostAlias" | "claudeCodeSocket">,
): Promise<Credential> {
  if (
    provider === "claude-code" &&
    credential.type === "api_key" &&
    credential.base_url &&
    vm.claudeCodeSocket
  ) {
    const path = await vm.claudeCodeSocket(credential.base_url);
    return { type: "claude_code_socket", key: credential.key, path };
  }
  return vmCredential(credential, vm);
}
