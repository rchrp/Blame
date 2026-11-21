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

/**
 * Where a session stands, from its records (it is opened if needed, and a
 * turn a crash cut is ended there as interrupted). A session the engine
 * does not have says `exists: false`; any other failure to read it throws:
 * "could not read" is not "not found".
 */
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
  } catch (error) {
    if (!unknownSession(error)) throw error;
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
    // A turn, not a compaction or another operation of the session.
    turnRunning: transcript.runningTurn !== undefined,
    ...(last ? { lastOutcome: last } : {}),
    ...(reply ? { lastReply: reply } : {}),
    turns: transcript.turns.length,
    ...(plan ? { plan } : {}),
    models: turnsByModel(transcript).map(({ model, turns }) => ({
      providerId: model.provider,
      modelId: model.model,
      turns,
    })),
    endedTurns: endedTurns.slice(-100).map((turn) => {
      const text = turnReply(turn, transcript.items)?.trim();
      return {
        turn: turn.turn,
        outcome: turn.outcome!,
        ...(text ? { reply: text } : {}),
      };
    }),
  };
}

// The engine's answer for a session neither this computer nor Blame's
// database has (`StoreError::UnknownSession`).
function unknownSession(error: unknown) {
  return (
    error instanceof Error && /session \S+ does not exist/.test(error.message)
  );
}
