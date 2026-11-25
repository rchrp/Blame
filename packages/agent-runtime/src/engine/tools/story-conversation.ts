// What an earlier story's agent did, read from its engine session: each
// turn's message, the messages sent into it, the tools it ran and its reply.
// `read_user_story` shows it for stories run on the engine, whose outcome,
// comments and activity are no longer copied to the story row. A merged
// story's session is gone from this computer; the native engine pulls it
// back from Blame's database when it opens it.

import {
  TranscriptReducer,
  turnReply,
  type EngineClient,
  type TranscriptItem,
} from "@blame/engine-client";

export type StoryConversationTurn = {
  /** The message that opened the turn (the brief, for the first). */
  message: string;
  /** Messages the person sent into the running turn. */
  steers: string[];
  /** How the turn ended (`completed`, `interrupted`…); absent while it runs. */
  outcome?: string;
  reply?: string;
  /** One line per tool call: its name and what it acted on. */
  tools: string[];
};

export type StoryConversation = { turns: StoryConversationTurn[] };

/** The session's turns, or undefined when no engine has the session. */
export async function readStoryConversation(
  client: EngineClient,
  session: string,
): Promise<StoryConversation | undefined> {
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
    if (
      error instanceof Error &&
      /session \S+ does not exist/.test(error.message)
    )
      return undefined;
    throw error;
  }
  const transcript = reducer.snapshot();
  const byTurn = new Map<string, TranscriptItem[]>();
  for (const item of transcript.items) {
    if (!("turn" in item)) continue;
    const items = byTurn.get(item.turn) ?? [];
    items.push(item);
    byTurn.set(item.turn, items);
  }
  const turns: StoryConversationTurn[] = [];
  for (const turn of transcript.turns) {
    if (turn.status === "rewound" || turn.status === "withdrawn") continue;
    const items = byTurn.get(turn.turn) ?? [];
    let message = "";
    const steers: string[] = [];
    const tools: string[] = [];
    for (const item of items) {
      if (item.kind === "user") {
        const text = userText(item.blocks);
        if (item.delivery === "steer") steers.push(text);
        else if (!message) message = text;
      } else if (item.kind === "tool_call") {
        tools.push(toolStep(item.name, item.input, item.state));
      }
    }
    const reply = turnReply(turn, transcript.items)?.trim();
    turns.push({
      message,
      steers,
      ...(turn.outcome ? { outcome: turn.outcome.status } : {}),
      ...(reply ? { reply } : {}),
      tools,
    });
  }
  return { turns };
}

function userText(blocks: readonly unknown[]) {
  return blocks
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

// The input fields that say what a call acted on, most telling first.
const subjectFields = [
  "command",
  "target",
  "query",
  "path",
  "story",
  "url",
  "area",
  "run",
  "summary",
];

function toolStep(name: string, input: unknown, state: string) {
  const fields =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const subject = subjectFields
    .map((field) => fields[field])
    .find((value): value is string => typeof value === "string" && !!value);
  const line = subject
    ? `${name}: ${subject.replace(/\s+/g, " ").trim()}`
    : name;
  const clipped = line.length > 160 ? `${line.slice(0, 159)}…` : line;
  return state === "failed" || state === "denied"
    ? `${clipped} (${state})`
    : clipped;
}
