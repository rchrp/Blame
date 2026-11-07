import type { AgentBackendConfig } from "./types.js";

type OneShotStart = { prompt?: string; interactive?: boolean };

type OneShotCore<T extends OneShotStart> = {
  start(input: T): Promise<{ sessionId: string; result?: unknown }>;
  send(input: { sessionId: string; prompt: string }): Promise<unknown>;
  stop(sessionId: string): Promise<void>;
};

// A hub or remote backend (a story in the Blame Runtime VM) creates the session
// and runs its prompt in the background: start() returns before the agent has
// done anything, without a result. Send the prompt as a turn instead, which
// resolves with the agent's result once it finishes.
export async function runOneShotAgent<T extends OneShotStart>(
  cline: OneShotCore<T>,
  input: T,
  backend?: AgentBackendConfig,
) {
  const { prompt, ...start } = input;
  if (!prompt || !backend || backend.mode === "local")
    return cline.start(input);
  const session = await cline.start({ ...start, interactive: true } as T);
  try {
    const result = await cline.send({ sessionId: session.sessionId, prompt });
    return { ...session, result };
  } finally {
    await cline.stop(session.sessionId).catch(() => undefined);
  }
}
