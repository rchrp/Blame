import { estimateRequestInputTokens } from "@cline/shared";
import {
  createContextCompactionPrepareTurn,
  createSessionCompactionState,
  projectSessionCompactionState,
  type ClineCore,
  type CoreCompactionConfig,
} from "@cline/sdk";
import type { ModelInfo } from "@cline/llms";

import { contextLimitConfig } from "./context-limit-config.js";

// Compacts an idle session's working context on request, with Cline's own
// manual compaction (the strategy automatic compaction uses, aiming at about
// half the current context). The result is stored as the session's
// compaction state, which the next resume hands back to Cline; the full
// transcript stays untouched.

export type ManualCompactionResult = {
  compacted: boolean;
  tokensAfter?: number;
  tokensBefore?: number;
};

export type ManualCompactionInput = {
  apiKey?: string;
  baseUrl?: string;
  cline: Pick<
    ClineCore,
    | "readMessages"
    | "readSessionCompactionState"
    | "updateSessionCompactionState"
  >;
  compaction: CoreCompactionConfig;
  maxInputTokens?: number;
  modelId: string;
  modelInfo?: ModelInfo;
  providerId: string;
  sessionId: string;
  // Tests replace Cline's compaction.
  createPrepareTurn?: typeof createContextCompactionPrepareTurn;
};

const compactionTimeoutMs = 180_000;

export async function compactSessionContext(
  input: ManualCompactionInput,
): Promise<ManualCompactionResult> {
  const source = await input.cline.readMessages(input.sessionId);
  if (!source.length) return { compacted: false };
  const state = await input.cline.readSessionCompactionState(input.sessionId);
  const working =
    (state && projectSessionCompactionState(state, source)) ?? source;
  const systemPrompt = state?.system_prompt ?? "";
  const conversationId = state?.conversation_id ?? input.sessionId;
  const createPrepareTurn =
    input.createPrepareTurn ?? createContextCompactionPrepareTurn;
  const prepareTurn = createPrepareTurn(
    {
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      sessionId: input.sessionId,
      compaction: { ...input.compaction, enabled: true },
      ...contextLimitConfig(input),
    },
    { mode: "manual" },
  );
  if (!prepareTurn) return { compacted: false };
  const tokensBefore = estimateRequestInputTokens({ messages: working });
  const result = await prepareTurn({
    agentId: input.sessionId,
    conversationId,
    parentAgentId: null,
    iteration: 0,
    messages: working,
    apiMessages: working,
    abortSignal: AbortSignal.timeout(compactionTimeoutMs),
    systemPrompt,
    tools: [],
    model: {
      id: input.modelId,
      provider: input.providerId,
      info: cappedModelInfo(input.modelInfo, input.maxInputTokens),
    },
  });
  const compacted = result?.messages;
  if (!compacted?.length || compacted === working) {
    return { compacted: false, tokensBefore };
  }
  await input.cline.updateSessionCompactionState(
    input.sessionId,
    createSessionCompactionState({
      sourceMessages: source,
      compactedMessages: compacted,
      conversationId,
      systemPrompt: systemPrompt || undefined,
    }),
  );
  return {
    compacted: true,
    tokensAfter: estimateRequestInputTokens({ messages: compacted }),
    tokensBefore,
  };
}

// The session's model as its sessions see it: a context cap is its window.
function cappedModelInfo(info: ModelInfo | undefined, cap: number | undefined) {
  if (!info || !cap) return info;
  return { ...info, contextWindow: cap, maxInputTokens: cap };
}
