// Where an epic's conversation stands, from its records: whether a turn
// runs or waits behind one, how its last turn ended (through which
// `end_turn`), what it spent, and every story turn a wake told it, rewound
// wakes included (a turn is told once, whatever the conversation undoes);
// a wake whose turn ended before it ever ran (withdrawn, or dropped behind
// an interrupted turn) told nothing.
// Records are read once each: a session's reducer is kept and fed the new
// ones.

import {
  TranscriptReducer,
  type EngineClient,
  type JsonValue,
  type SessionConfig,
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
  /** The turn that runs. */
  runningTurn?: string;
  /** Turns waiting to run while none runs (they waited through a quit). */
  queued: string[];
  /** The last turn that ended, how, and the `end_turn` it was accepted with. */
  last?: { turn: string; outcome: TurnOutcome; endTurn?: EndTurn };
  /** `session\nturn` of each story turn a wake carried. */
  reported: ReadonlySet<string>;
  /** The turns whose message is a host's wake (never the person's). */
  wakes: ReadonlySet<string>;
  spentMicroUsd: number;
  unpricedRequests: number;
  /** The config in effect (the folder it reads, its model, its prompt). */
  config?: SessionConfig;
  /**
   * The completed `message_story` calls, by the story named, in all and
   * those counted as requests for changes (its result says so).
   */
  messages: {
    all: Record<string, number>;
    changes: Record<string, number>;
  };
  /** What its boards and reports showed of each story: the turns named, the cost last shown. */
  shown: Record<string, { turns: string[]; costMicroUsd?: number }>;
};

/** The key a story turn is known by. */
export function turnKey(session: string, turn: string) {
  return `${session}\n${turn}`;
}

type Held = {
  reducer: TranscriptReducer;
  /** Each wake's turn → the story turns it carried. */
  wakes: Map<string, string[]>;
  /** Turns that sent a request, and turns that ended. */
  ran: Set<string>;
  ended: Set<string>;
};

export class ConversationReader {
  private readonly sessions = new Map<string, Held>();

  async read(client: EngineClient, session: string): Promise<ConversationView> {
    let held = this.sessions.get(session);
    if (!held) {
      held = {
        reducer: new TranscriptReducer(),
        wakes: new Map(),
        ran: new Set(),
        ended: new Set(),
      };
      this.sessions.set(session, held);
    }
    try {
      for (;;) {
        const page = await client.readRecords({
          session,
          after: held.reducer.lastSeq,
          limit: 1000,
        });
        for (const record of page.records) noteWake(record, held);
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
        wakes: new Set(),
        spentMicroUsd: 0,
        unpricedRequests: 0,
        messages: { all: {}, changes: {} },
        shown: {},
      };
    }
    return view(held);
  }

  forget(session: string) {
    this.sessions.delete(session);
  }
}

function noteWake(record: SessionRecord, held: Held) {
  if (record.type === "request_started") held.ran.add(record.turn);
  if (record.type === "turn_ended") held.ended.add(record.turn);
  if (record.type !== "user_message") return;
  const wake = parseOrchestratorWake(record.input);
  if (!wake) return;
  const told = held.wakes.get(record.turn) ?? [];
  for (const story of wake.stories)
    if (typeof story.turn === "string" && typeof story.session === "string")
      told.push(turnKey(story.session, story.turn));
  held.wakes.set(record.turn, told);
}

function view({ reducer, wakes, ran, ended: over }: Held): ConversationView {
  const reported = new Set<string>();
  for (const [turn, told] of wakes)
    if (ran.has(turn) || !over.has(turn))
      for (const key of told) reported.add(key);
  const transcript = reducer.snapshot();
  const open = transcript.turns.filter((turn) => !turn.outcome);
  const ended = transcript.turns.filter(
    (turn) => turn.outcome && turn.status !== "withdrawn",
  );
  const lastTurn = ended.at(-1);
  const { messages, shown } = toolFacts(transcript.items);
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
    ...(transcript.runningTurn ? { runningTurn: transcript.runningTurn } : {}),
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
    wakes: new Set(wakes.keys()),
    spentMicroUsd: transcript.usage.spent.costMicroUsd,
    unpricedRequests: transcript.usage.spent.unpricedRequests,
    ...(transcript.config ? { config: transcript.config } : {}),
    messages,
    shown,
  };
}

type Item = ReturnType<TranscriptReducer["snapshot"]>["items"][number];

// What its own completed tools did, from their inputs and results (the
// JSON the host answered): read again when the kept file is lost.
function toolFacts(items: readonly Item[]) {
  const messages = {
    all: {} as Record<string, number>,
    changes: {} as Record<string, number>,
  };
  const shown: ConversationView["shown"] = {};
  const see = (row: unknown, turn: unknown) => {
    const { id, costMicroUsd } = (row ?? {}) as Record<string, unknown>;
    if (typeof id !== "string") return;
    const seen = (shown[id] ??= { turns: [] });
    if (typeof turn === "string" && !seen.turns.includes(turn))
      seen.turns.push(turn);
    if (typeof costMicroUsd === "number") seen.costMicroUsd = costMicroUsd;
  };
  for (const item of items) {
    if (item.kind !== "tool_call" || item.state !== "completed") continue;
    const result = resultJson(item.result);
    if (item.name === "message_story") {
      const input = item.input as { storyId?: unknown; kind?: unknown } | null;
      if (typeof input?.storyId !== "string") continue;
      const id = input.storyId;
      messages.all[id] = (messages.all[id] ?? 0) + 1;
      // A message to a story in review counted as one whatever its kind.
      if (input.kind === "changes" || result?.changesRequested !== undefined)
        messages.changes[id] = (messages.changes[id] ?? 0) + 1;
    } else if (item.name === "epic_board" && Array.isArray(result?.stories)) {
      for (const row of result.stories as unknown[])
        see(row, (row as { lastTurn?: { turn?: unknown } })?.lastTurn?.turn);
    } else if (item.name === "story_report" && result) see(result, result.turn);
  }
  return { messages, shown };
}

function resultJson(
  result: Extract<Item, { kind: "tool_call" }>["result"],
): Record<string, unknown> | undefined {
  const block = result?.find((item) => item.type === "text");
  if (!block || block.type !== "text") return undefined;
  try {
    const value: unknown = JSON.parse(block.text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
