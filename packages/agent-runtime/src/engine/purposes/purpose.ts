// What a purpose is to the host: how to build its session config from the
// renderer's settings, where its workspace is, and what wraps the first
// message of a conversation.

import type { SessionConfig } from "@blame/engine-client";
import {
  engineProviderId,
  engineReasoning,
  type EngineMessage,
  type EngineModelChoice,
  type EngineWorkspace,
} from "../protocol.js";
import type { ToolSet } from "../tool.js";

export type PurposeContext = {
  tools: ToolSet;
  /** The client tools this session gets, by name (tool-sets.ts, and any the host adds). */
  clientTools: readonly string[];
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

/** The engine's model for the app's choice, or a clear refusal. */
export function engineModel(choice: EngineModelChoice) {
  const provider = engineProviderId(choice.providerId);
  if (!provider)
    throw new Error(
      `${choice.providerId} models do not run on Blame's agent engine yet. Pick a model from Anthropic, OpenAI, ChatGPT, Gemini, OpenRouter, an OpenAI-compatible provider or Claude Code.`,
    );
  const reasoning = engineReasoning(choice.reasoning);
  return {
    model: { provider, model: choice.modelId },
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
