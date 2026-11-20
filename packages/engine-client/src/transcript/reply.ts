import type { TranscriptItem, TurnView } from "./model.js";

/** The accepted finish summary takes precedence over the turn's last assistant text. */
export function turnReply(turn: TurnView, items: readonly TranscriptItem[]): string | undefined {
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
