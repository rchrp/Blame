// Each tool bounds the text it returns, at a size that suits what it is for,
// and says how to get more where it can. Cline's message builder still cuts
// the middle out of any text block over 100,000 characters, but only as a
// backstop (see patches/README.md). The harness tools page their own output.

export type TextLimit = {
  characters: number;
  /** Which end to keep: the start of a page or answer, the end of a log. */
  keep?: "head" | "tail";
  /** How to get the rest, added to the truncation note. */
  more?: string;
};

export const toolOutputLimits = {
  /** A browser DevTools result: a DOM snapshot, script value, trace or list. */
  previewDevtools: {
    characters: 40_000,
    more: "Narrow the call: snapshot or inspect one element, page list results with pageIdx/pageSize, or return less from evaluate_script.",
  },
  /** A terminal, display or device surface result. */
  previewSurface: {
    characters: 40_000,
    more: "Narrow the request, such as wait_for one pattern or fewer device logs.",
  },
  /** Preview container stdout: the latest lines matter. */
  previewLogStdout: {
    characters: 24_000,
    keep: "tail",
    more: "The latest lines are kept. Pass service to read one service, or a smaller tailLines.",
  },
  previewLogStderr: {
    characters: 8_000,
    keep: "tail",
    more: "The latest lines are kept. Pass service to read one service, or a smaller tailLines.",
  },
  /** A component preview report next to its screenshot. */
  componentPreview: {
    characters: 12_000,
    more: "Read the console and overlay with the preview_devtools tools for the full text.",
  },
  /** A specialist's answer: a concise recommendation. */
  specialistAnswer: {
    characters: 20_000,
    more: "Ask the specialist a narrower question for the rest.",
  },
  specialistFailure: { characters: 2_000 },
} satisfies Record<string, TextLimit>;

/** The text within the limit, cut on a line boundary where it can, with a note. */
export function limitText(text: string, limit: TextLimit): string {
  if (text.length <= limit.characters) return text;
  const tail = limit.keep === "tail";
  let kept: string;
  if (tail) {
    const from = text.length - limit.characters;
    const newline = text.indexOf("\n", from);
    kept = text.slice(
      newline >= 0 && newline < from + limit.characters / 2
        ? newline + 1
        : from,
    );
  } else {
    const newline = text.lastIndexOf("\n", limit.characters);
    kept = text.slice(
      0,
      newline > limit.characters / 2 ? newline : limit.characters,
    );
  }
  const omitted = text.length - kept.length;
  const note = `[Cut to ${limit.characters} characters: the ${tail ? "first" : "last"} ${omitted} of ${text.length} are omitted.${limit.more ? ` ${limit.more}` : ""}]`;
  return tail ? `${note}\n${kept}` : `${kept}\n${note}`;
}

/**
 * Bounds the text of a tool output in MCP or SDK shape: a string, an array of
 * content parts, or an object with a `content` array. The limit applies to
 * all text parts together; images and other parts are kept.
 */
export function limitToolText<T>(output: T, limit: TextLimit): T {
  if (typeof output === "string") return limitText(output, limit) as T;
  if (Array.isArray(output)) return limitParts(output, limit) as T;
  const content =
    output && typeof output === "object"
      ? (output as { content?: unknown }).content
      : undefined;
  if (Array.isArray(content)) {
    const limited = limitParts(content, limit);
    return limited === content ? output : { ...output, content: limited };
  }
  return output;
}

function limitParts(parts: unknown[], limit: TextLimit) {
  const total = parts.reduce<number>(
    (sum, part) => sum + (textPart(part) ? part.text.length : 0),
    0,
  );
  if (total <= limit.characters) return parts;
  let remaining = limit.characters,
    dropped = 0;
  const limited = parts.flatMap((part) => {
    if (!textPart(part)) return [part];
    if (remaining <= 0) {
      dropped += 1;
      return [];
    }
    const fits = part.text.length <= remaining;
    const text = fits
      ? part.text
      : limitText(part.text, { ...limit, characters: remaining });
    remaining -= part.text.length;
    return [fits ? part : { ...part, text }];
  });
  return dropped
    ? [
        ...limited,
        { type: "text", text: `[${dropped} further text part(s) omitted.]` },
      ]
    : limited;
}

function textPart(part: unknown): part is { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}
