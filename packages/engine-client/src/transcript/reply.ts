import type { TranscriptItem, TurnView } from "./model.js";

/**
 * The turn's reply: its accepted finish summary, else its last assistant
 * text. A turn that stopped after the finish was refused because checks
 * still fail keeps that text as its reply, unverified, with a note naming
 * the checks.
 */
export function turnReply(turn: TurnView, items: readonly TranscriptItem[]): string | undefined {
  const reply = replyOf(turn, items);
  const failing = unverifiedChecks(turn);
  if (reply === undefined || !failing) return reply;
  return `${reply.trimEnd()}\n\n> **Not verified:** the last run of \`${failing}\` failed.`;
}

/**
 * The checks a turn ended with still failing, when it stopped without an
 * accepted finish because they failed: its reply is not verified.
 */
export function unverifiedChecks(turn: Pick<TurnView, "outcome">): string | undefined {
  const outcome = turn.outcome;
  if (outcome?.status !== "contract_unmet") return undefined;
  const refused = outcome.refused;
  if (refused?.kind !== "failing_checks" || !refused.tasks.length) return undefined;
  return refused.tasks.join(", ");
}

function replyOf(turn: TurnView, items: readonly TranscriptItem[]): string | undefined {
  if (!turn.outcome) return undefined;

  let text: string | undefined;
  for (const item of items) {
    if (!("turn" in item) || item.turn !== turn.turn) continue;
    if (item.kind === "text" && item.text.trim()) text = item.text;
    if (item.kind === "tool_call" && item.name === "finish_task" && item.state === "completed") {
      const input = item.input;
      const summary = input && typeof input === "object" && !Array.isArray(input)
        ? input.summary
        : undefined;
      if (typeof summary === "string" && summary.trim()) return summary;
    }
  }
  return text;
}

/**
 * The screenshots an accepted finish attached to the reply (`images` of
 * finish_task, refs `screenshot:<id>`), in order, each once.
 */
export function turnReplyImages(
  turn: TurnView,
  items: readonly TranscriptItem[],
): Array<{ caption: string; id: string }> {
  let input: unknown;
  for (const item of items)
    if (
      "turn" in item &&
      item.turn === turn.turn &&
      item.kind === "tool_call" &&
      item.name === "finish_task" &&
      item.state === "completed"
    )
      input = item.input;
  const images =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { images?: unknown }).images
      : undefined;
  if (!Array.isArray(images)) return [];
  const result: Array<{ caption: string; id: string }> = [];
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image)) continue;
    const { ref, caption } = image as { ref?: unknown; caption?: unknown };
    const id = typeof ref === "string" ? /^screenshot:([0-9a-f]{64})$/u.exec(ref)?.[1] : undefined;
    if (!id || result.some((known) => known.id === id)) continue;
    result.push({ caption: typeof caption === "string" ? caption : "", id });
  }
  return result;
}
