// What a purpose is to the host: how to build its session config from the
// renderer's settings, where its workspace is, and what wraps the first
// message of a conversation.

import type { SessionConfig } from "@blame/engine-client";
import {
  engineReasoning,
  type EngineMessage,
  type EngineModelChoice,
  type EngineWorkspace,
} from "../protocol.js";
import type { ToolSet } from "../tool.js";

export type PurposeContext = {
  tools: ToolSet;
  /** The shared client tools this session gets, by name (tool-sets.ts, and any the host adds). */
  clientTools: readonly string[];
  /**
   * Every client tool name the session offers: the shared ones and the
   * conversation's own (`ConversationTools`), whose specs and prompt
   * section the host adds to the config.
   */
  toolNames: readonly string[];
  /** The day the conversation started (its first record). */
  promptDate: Date;
};

export type FirstMessageServices = {
  /** The person's project memories relevant to this message, as a briefing. */
  projectMemory?(input: {
    projectId: string;
    workspaceRoot: string;
    objective: string;
  }): Promise<string | undefined>;
};

export type Purpose<Settings> = {
  workspace(settings: Settings, session: string): EngineWorkspace;
  config(
    settings: Settings,
    session: string,
    context: PurposeContext,
  ): SessionConfig;
  /** Wraps the conversation's first message (a story's brief, its briefing). */
  firstMessage?(
    settings: Settings,
    message: EngineMessage,
    services: FirstMessageServices,
  ): Promise<EngineMessage>;
};

/** The engine's model for the picked one (the app uses the engine's provider ids). */
export function engineModel(choice: EngineModelChoice) {
  const reasoning = engineReasoning(choice.reasoning);
  return {
    model: { provider: choice.providerId, model: choice.modelId },
    ...(reasoning ? { reasoning } : {}),
  };
}

/** Names of every tool a session offers: its client tools and its harness tools. */
export function sessionToolNames(
  clientTools: readonly string[],
  harnessTools: readonly string[] | undefined,
) {
  return [
    ...clientTools,
    ...(harnessTools ?? [
      "search_code",
      "read_code",
      "edit_code",
      "run_task",
      "finish_task",
    ]),
  ];
}
