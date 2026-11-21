// What `status` answers for a session: where it stands, read from its
// records (docs/engine-in-the-app.md, "IPC surface").

import {
  TranscriptReducer,
  planProgress,
  turnReply,
  turnsByModel,
  type EngineClient,
} from "@blame/engine-client";
import type { EngineSessionStatus } from "./protocol.js";

/** Where a session stands, from its records (it is opened if needed). */
export async function sessionStatus(
  client: EngineClient,
  session: string,
  running: ReadonlySet<string>,
): Promise<EngineSessionStatus> {
  const reducer = new TranscriptReducer();
  try {
    for (;;) {
      const page = await client.readRecords({
        session,
        after: reducer.lastSeq,
        limit: 1000,
      });
      reducer.applyRecords(page.records);
      if (!page.records.length || reducer.lastSeq >= page.head) break;
    }
  } catch {
    return { session, exists: false, running: false, turns: 0, models: [] };
  }
  const transcript = reducer.snapshot();
  const endedTurns = transcript.turns.filter((turn) => turn.outcome);
  const ended = endedTurns.at(-1);
  const last = ended?.outcome;
  const reply = ended ? turnReply(ended, transcript.items)?.trim() : undefined;
  const plan = planProgress(transcript.plan);
  return {
    session,
    exists: true,
    running: running.has(session) || transcript.runningTurn !== undefined,
    ...(last ? { lastOutcome: last } : {}),
    ...(reply ? { lastReply: reply } : {}),
    turns: transcript.turns.length,
    ...(plan ? { plan } : {}),
    models: turnsByModel(transcript).map(({ model, turns }) => ({
      providerId: model.provider,
      modelId: model.model,
      turns,
    })),
    endedTurns: endedTurns.slice(-20).map((turn) => {
      const text = turnReply(turn, transcript.items)?.trim();
      return {
        turn: turn.turn,
        outcome: turn.outcome!,
        ...(text ? { reply: text } : {}),
      };
    }),
  };
}
