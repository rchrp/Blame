import type {
  AgentScreenshotMetadata,
  AgentScreenshotStore,
} from "./agent-screenshot-store.ts";

// Turns the images of a preview DevTools result into stored screenshots.
// The original is kept for the user. The model gets a copy no larger than
// 1568 px on its longest side, re-encoded as JPEG when the PNG stays heavy,
// plus a line naming the screenshot so it can attach it to its answer.

export type ImageCodec = {
  size(data: Buffer): { height: number; width: number };
  encode(
    data: Buffer,
    target: { height: number; width: number },
    format: "jpeg" | "png",
  ): Buffer;
};

export type PreviewPageState = {
  colorScheme: "dark" | "light";
  url: string;
  viewport: { height: number; width: number };
};

export type ScreenshotCaptureContext = {
  page?: PreviewPageState;
  runId?: string;
  scope: string;
  sessionId?: string;
  toolCallId?: string;
};

type McpImage = { data: string; mimeType: string; type: "image" };

export const modelImageMaximumSide = 1568;
export const modelPngMaximumBytes = 1.5 * 1024 * 1024;

export function modelImageTarget(width: number, height: number) {
  const longest = Math.max(width, height);
  if (longest <= modelImageMaximumSide) return { height, width };
  const scale = modelImageMaximumSide / longest;
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

export async function storeResultScreenshots(
  result: unknown,
  context: ScreenshotCaptureContext,
  store: AgentScreenshotStore,
  codec: ImageCodec,
): Promise<unknown> {
  const record = recordValue(result);
  const content = Array.isArray(record.content) ? record.content : undefined;
  if (!content?.some(mcpImage)) return result;
  const screenshots: AgentScreenshotMetadata[] = [];
  const blocks: unknown[] = [];
  for (const block of content) {
    if (!mcpImage(block)) {
      blocks.push(block);
      continue;
    }
    const original = Buffer.from(block.data, "base64");
    const size = codec.size(original);
    const metadata = await store.save({
      colorScheme: context.page?.colorScheme ?? "light",
      data: original,
      height: size.height,
      mimeType: block.mimeType,
      pageUrl: context.page?.url ?? "",
      ...(context.runId ? { runId: context.runId } : {}),
      scope: context.scope,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      viewport: context.page?.viewport ?? size,
      width: size.width,
    });
    screenshots.push(metadata);
    blocks.push(modelImage(block, original, size, codec));
  }
  return {
    ...record,
    content: [
      ...blocks,
      ...screenshots.map((metadata) => ({
        text: screenshotLine(metadata),
        type: "text",
      })),
    ],
    _meta: {
      ...recordValue(record._meta),
      blameScreenshots: screenshots.map(screenshotReference),
    },
  };
}

export function screenshotLine(metadata: AgentScreenshotMetadata) {
  return `Screenshot saved as screenshot:${metadata.id} (${metadata.width}×${metadata.height}, ${metadata.colorScheme}). Attach it to finish_task with this reference when it shows the result.`;
}

function screenshotReference(metadata: AgentScreenshotMetadata) {
  return {
    colorScheme: metadata.colorScheme,
    height: metadata.height,
    id: metadata.id,
    mimeType: metadata.mimeType,
    pageUrl: metadata.pageUrl,
    ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
    viewport: metadata.viewport,
    width: metadata.width,
  };
}

function modelImage(
  block: McpImage,
  original: Buffer,
  size: { height: number; width: number },
  codec: ImageCodec,
): McpImage {
  const target = modelImageTarget(size.width, size.height);
  const sameSize = target.width === size.width && target.height === size.height;
  if (sameSize && original.byteLength <= modelPngMaximumBytes) return block;
  const png = codec.encode(original, target, "png");
  if (png.byteLength <= modelPngMaximumBytes)
    return {
      data: png.toString("base64"),
      mimeType: "image/png",
      type: "image",
    };
  const jpeg = codec.encode(original, target, "jpeg");
  return {
    data: jpeg.toString("base64"),
    mimeType: "image/jpeg",
    type: "image",
  };
}

function mcpImage(value: unknown): value is McpImage {
  const record = recordValue(value);
  return (
    record.type === "image" &&
    typeof record.data === "string" &&
    typeof record.mimeType === "string"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
