// Preview screenshots travel two ways. The model receives the image itself,
// as a native image block, so it can look at its work. The activity shown to
// the user and saved with the story only keeps a small reference: the image
// stays in Blame's screenshot store.

export type ScreenshotColorScheme = "dark" | "light";

export type ScreenshotMetadata = {
  colorScheme: ScreenshotColorScheme;
  height: number;
  id: string;
  mimeType: string;
  pageUrl: string;
  sessionId?: string;
  viewport: { height: number; width: number };
  width: number;
};

export type ScreenshotRef = ScreenshotMetadata & { type: "screenshot_ref" };

type NativeImage = {
  blameScreenshot?: ScreenshotMetadata;
  data: string;
  mediaType: string;
  type: "image";
};

export const screenshotIdPattern = /^[0-9a-f]{64}$/u;

// An MCP result with images becomes a list of content blocks. Cline keeps
// such a list as the tool result; an object would be serialized as JSON and
// the image would reach the model as base64 text.
export function previewToolModelOutput(result: unknown): unknown {
  const record = recordValue(result);
  if (!Array.isArray(record.content)) return result;
  const content = record.content as unknown[];
  if (!content.some(mcpImage)) return result;
  const screenshots = Array.isArray(recordValue(record._meta).blameScreenshots)
    ? (recordValue(record._meta).blameScreenshots as unknown[])
    : [];
  let imageIndex = 0;
  return content.flatMap((block): unknown[] => {
    if (mcpImage(block)) {
      const metadata = screenshotMetadata(screenshots[imageIndex++]);
      return [
        {
          data: block.data,
          mediaType: block.mimeType,
          type: "image",
          ...(metadata ? { blameScreenshot: metadata } : {}),
        } satisfies NativeImage,
      ];
    }
    const text = recordValue(block);
    return text.type === "text" && typeof text.text === "string"
      ? [{ text: text.text, type: "text" }]
      : [];
  });
}

// Replaces every stored screenshot in a tool output with its reference.
// Images that are not stored screenshots are left untouched.
export function withScreenshotRefs<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = withScreenshotRefs(item);
      if (replaced !== item) changed = true;
      return replaced;
    });
    return (changed ? next : value) as T;
  }
  if (!value || typeof value !== "object") return value;
  const ref = screenshotRef(value);
  if (ref) return ref as T;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const replaced = withScreenshotRefs(item);
    if (replaced !== item) changed = true;
    return [key, replaced] as const;
  });
  return (changed ? Object.fromEntries(entries) : value) as T;
}

export function screenshotIdsIn(value: unknown, ids: string[] = []) {
  if (Array.isArray(value)) value.forEach((item) => screenshotIdsIn(item, ids));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const metadata =
      screenshotMetadata(record.blameScreenshot) ??
      (record.type === "screenshot_ref"
        ? screenshotMetadata(record)
        : undefined);
    if (metadata) ids.push(metadata.id);
    else Object.values(record).forEach((item) => screenshotIdsIn(item, ids));
  }
  return ids;
}

function screenshotRef(value: object): ScreenshotRef | undefined {
  const record = value as Record<string, unknown>;
  if (record.type !== "image" || typeof record.data !== "string") return;
  const metadata = screenshotMetadata(record.blameScreenshot);
  if (!metadata) return undefined;
  return { type: "screenshot_ref", ...metadata };
}

export function screenshotMetadata(
  value: unknown,
): ScreenshotMetadata | undefined {
  const record = recordValue(value);
  const viewport = recordValue(record.viewport);
  if (
    typeof record.id !== "string" ||
    !screenshotIdPattern.test(record.id) ||
    typeof record.mimeType !== "string" ||
    !positiveNumber(record.width) ||
    !positiveNumber(record.height)
  )
    return undefined;
  return {
    colorScheme: record.colorScheme === "dark" ? "dark" : "light",
    height: record.height,
    id: record.id,
    mimeType: record.mimeType,
    pageUrl: typeof record.pageUrl === "string" ? record.pageUrl : "",
    ...(typeof record.sessionId === "string" && record.sessionId
      ? { sessionId: record.sessionId }
      : {}),
    viewport: {
      height: positiveNumber(viewport.height) ? viewport.height : record.height,
      width: positiveNumber(viewport.width) ? viewport.width : record.width,
    },
    width: record.width,
  };
}

function mcpImage(
  value: unknown,
): value is { data: string; mimeType: string; type: "image" } {
  const record = recordValue(value);
  return (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Screenshots each conversation has taken in this process, so finish_task
// can only show the user screenshots from its own conversation.
const sessionScreenshots = new Map<string, Set<string>>();
const maximumTrackedSessions = 200;

export function recordSessionScreenshots(
  sessionId: string | undefined,
  value: unknown,
) {
  if (!sessionId) return;
  const ids = screenshotIdsIn(value);
  if (!ids.length) return;
  const known = sessionScreenshots.get(sessionId) ?? new Set<string>();
  ids.forEach((id) => known.add(id));
  sessionScreenshots.delete(sessionId);
  sessionScreenshots.set(sessionId, known);
  while (sessionScreenshots.size > maximumTrackedSessions) {
    const oldest = sessionScreenshots.keys().next().value;
    if (oldest === undefined) break;
    sessionScreenshots.delete(oldest);
  }
}

export function sessionScreenshotIds(sessionId: string | undefined) {
  return (sessionId && sessionScreenshots.get(sessionId)) || new Set<string>();
}
