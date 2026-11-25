// What the orchestrator writes for people and agents to read (a brief, a
// message, a summary) is Markdown. A model sometimes escapes it twice in a
// tool call's JSON, so its line breaks arrive as the two characters `\n`
// and its quotes as `\"` (two of the four messages of the first real epic,
// 2026-11-25). A text with no real line break and several `\n` was escaped
// twice: it is decoded once. Anything else is left as written, so a single
// `\n` in a one-line text (a regex, an example) stays.

export function readableText(text: string): string;
export function readableText(text: string | undefined): string | undefined;
export function readableText(text: string | undefined) {
  if (text === undefined || text.includes("\n")) return text;
  if ((text.match(/\\n/g) ?? []).length < 2) return text;
  return text.replace(/\\(["\\nrt])/g, (_, character: string) =>
    character === "n"
      ? "\n"
      : character === "t"
        ? "\t"
        : character === "r"
          ? ""
          : character,
  );
}
