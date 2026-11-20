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
