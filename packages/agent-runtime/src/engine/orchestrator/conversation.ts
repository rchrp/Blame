// Where an epic's conversation stands, from its records: whether a turn
// runs or waits behind one, how its last turn ended (through which
// `end_turn`), what it spent, and every story turn a wake told it, rewound
// wakes included (a turn is told once, whatever the conversation undoes).
// Records are read once each: a session's reducer is kept and fed the new
// ones.

import {
  TranscriptReducer,
  type EngineClient,
  type JsonValue,
  type SessionRecord,
  type TurnOutcome,
} from "@blame/engine-client";
import {
  parseOrchestratorWake,
  type OrchestratorConversationState,
  type OrchestratorToolInputs,
} from "../protocol.js";

export type EndTurn = OrchestratorToolInputs["end_turn"];

export type ConversationView = {
  exists: boolean;
  /** A turn runs. */
  running: boolean;
  /** Turns waiting to run while none runs (they waited through a quit). */
  queued: string[];
  /** The last turn that ended, how, and the `end_turn` it was accepted with. */
  last?: { turn: string; outcome: TurnOutcome; endTurn?: EndTurn };
  /** `session\nturn` of each story turn a wake carried. */
  reported: ReadonlySet<string>;
  spentMicroUsd: number;
  unpricedRequests: number;
};

/** The key a story turn is known by. */
export function turnKey(session: string, turn: string) {
  return `${session}\n${turn}`;
}

type Held = { reducer: TranscriptReducer; reported: Set<string> };

export class ConversationReader {
  private readonly sessions = new Map<string, Held>();

  async read(client: EngineClient, session: string): Promise<ConversationView> {
    let held = this.sessions.get(session);
    if (!held) {
      held = { reducer: new TranscriptReducer(), reported: new Set() };
      this.sessions.set(session, held);
    }
    try {
      for (;;) {
        const page = await client.readRecords({
          session,
          after: held.reducer.lastSeq,
          limit: 1000,
        });
        for (const record of page.records) noteWake(record, held.reported);
        held.reducer.applyRecords(page.records);
        if (!page.records.length || held.reducer.lastSeq >= page.head) break;
      }
    } catch (error) {
      if (!/session \S+ does not exist/.test(String(error))) throw error;
      this.sessions.delete(session);
      return {
        exists: false,
        running: false,
        queued: [],
        reported: new Set(),
        spentMicroUsd: 0,
        unpricedRequests: 0,
      };
    }
    return view(held);
  }

  forget(session: string) {
    this.sessions.delete(session);
  }
}

function noteWake(record: SessionRecord, reported: Set<string>) {
  if (record.type !== "user_message") return;
  const wake = parseOrchestratorWake(record.input);
  for (const story of wake?.stories ?? [])
    if (typeof story.turn === "string" && typeof story.session === "string")
      reported.add(turnKey(story.session, story.turn));
}

function view({ reducer, reported }: Held): ConversationView {
  const transcript = reducer.snapshot();
  const open = transcript.turns.filter((turn) => !turn.outcome);
  const ended = transcript.turns.filter(
    (turn) => turn.outcome && turn.status !== "withdrawn",
  );
  const lastTurn = ended.at(-1);
  let endTurn: EndTurn | undefined;
  if (lastTurn)
    for (const item of transcript.items)
      if (
        item.kind === "tool_call" &&
        item.turn === lastTurn.turn &&
        item.name === "end_turn" &&
        item.state === "completed"
      )
        endTurn = endTurnInput(item.input);
  return {
    exists: true,
    running: transcript.runningTurn !== undefined,
    queued: transcript.runningTurn
      ? []
      : open.filter((turn) => turn.status === "queued").map(({ turn }) => turn),
    ...(lastTurn
      ? {
          last: {
            turn: lastTurn.turn,
            outcome: lastTurn.outcome!,
            ...(endTurn ? { endTurn } : {}),
          },
        }
      : {}),
    reported,
    spentMicroUsd: transcript.usage.spent.costMicroUsd,
    unpricedRequests: transcript.usage.spent.unpricedRequests,
  };
}

function endTurnInput(input: JsonValue): EndTurn | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const action = input.action;
  if (action !== "wait" && action !== "ask" && action !== "finish")
    return undefined;
  return input as unknown as EndTurn;
}

/**
 * The conversation's state for the screen: `stopped` is a turn the person
 * interrupted (the host was told), `failed` one that ended any other way
 * than through an accepted `end_turn`, a quit's interruption included.
 */
export function conversationState(
  conversation: ConversationView | undefined,
  stoppedByPerson: boolean,
): { state: OrchestratorConversationState; error?: string } {
  if (!conversation?.exists) return { state: "idle" };
  if (conversation.running || conversation.queued.length)
    return { state: "working" };
  const last = conversation.last;
  if (!last) return { state: "idle" };
  if (last.endTurn?.action === "wait") return { state: "waiting" };
  if (last.endTurn?.action === "ask") return { state: "asking" };
  if (last.endTurn?.action === "finish") return { state: "finished" };
  if (last.outcome.status === "interrupted")
    return stoppedByPerson
      ? { state: "stopped" }
      : { state: "failed", error: "Blame stopped while it was working." };
  return { state: "failed", error: outcomeError(last.outcome) };
}

function outcomeError(outcome: TurnOutcome): string {
  switch (outcome.status) {
    case "failed":
      return outcome.error.message;
    case "limit_reached":
      return `It reached a limit (${outcome.limit}).`;
    case "contract_unmet":
      return "It stopped without ending its turn through end_turn.";
    default:
      return "Its turn did not end through end_turn.";
  }
}
