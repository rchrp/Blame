import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@cline/sdk";
import { createHandler } from "@cline/llms";
import { normalizeEvent } from "./cline-runtime-events.js";
import { projectImageContext } from "./image-context.js";
import {
  previewToolModelOutput,
  screenshotIdsIn,
  withScreenshotRefs,
} from "./preview-screenshots.js";

const id = "a".repeat(64);
const base64 = Buffer.alloc(40_000, 7).toString("base64");
const metadata = {
  colorScheme: "dark",
  height: 900,
  id,
  mimeType: "image/png",
  pageUrl: "http://127.0.0.1:5173/settings/providers",
  sessionId: "session-1",
  viewport: { height: 900, width: 1440 },
  width: 1440,
};

function screenshotResult() {
  return {
    content: [
      { type: "text", text: "Took a screenshot of the current page." },
      { type: "image", data: base64, mimeType: "image/png" },
      {
        type: "text",
        text: `Screenshot saved as screenshot:${id} (1440×900, dark)`,
      },
    ],
    _meta: { blameScreenshots: [metadata], previewReadyEvidence: {} },
  };
}

test("a screenshot result reaches the model as text and a native image", () => {
  const output = previewToolModelOutput(screenshotResult());
  assert.ok(Array.isArray(output));
  assert.deepEqual(
    output.map((block) => (block as { type: string }).type),
    ["text", "image", "text"],
  );
  const image = output[1] as Record<string, unknown>;
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.data, base64);
  assert.equal("mimeType" in image, false);
  assert.match(
    (output[2] as { text: string }).text,
    new RegExp(`screenshot:${id}`),
  );
});

test("results without images keep their object shape", () => {
  const result = {
    content: [{ type: "text", text: "uid=1 heading" }],
    _meta: { previewReadyEvidence: { status: "passed" } },
  };
  assert.equal(previewToolModelOutput(result), result);
});

test("the image context budget sees converted preview screenshots", () => {
  const output = previewToolModelOutput(screenshotResult()) as unknown[];
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "shot-1",
          name: "preview_devtools__take_screenshot",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "shot-1",
          name: "preview_devtools__take_screenshot",
          content: output,
        },
      ],
    },
  ] as unknown as Message[];
  const duplicated = [...messages, ...structuredClone(messages)];
  const projected = projectImageContext(duplicated);
  const text = JSON.stringify(projected);
  // The second copy is recognized as an image and deduplicated.
  assert.match(text, /Duplicate image data/);
  assert.equal(text.split(base64).length - 1, 1);
});

test("saved activities keep a small reference instead of base64", () => {
  const output = previewToolModelOutput(screenshotResult());
  const replaced = withScreenshotRefs({ output, toolName: "take_screenshot" });
  const serialized = JSON.stringify(replaced);
  assert.equal(serialized.includes(base64), false);
  assert.ok(serialized.length < 4_096, String(serialized.length));
  const ref = (replaced.output as unknown[])[1] as Record<string, unknown>;
  assert.deepEqual(ref, { type: "screenshot_ref", ...metadata });
  assert.deepEqual(screenshotIdsIn(replaced), [id]);
  assert.deepEqual(screenshotIdsIn(output), [id]);
});

test("other images and unchanged values are left as they are", () => {
  const value = { output: [{ type: "image", data: "AAA", mediaType: "x" }] };
  assert.equal(withScreenshotRefs(value), value);
});

test("tool events carry references in their output and raw payload", () => {
  const output = previewToolModelOutput(screenshotResult());
  const event = normalizeEvent("session-1", {
    type: "hook",
    payload: {
      hookEventName: "tool_result",
      sessionId: "session-1",
      toolName: "preview_devtools__take_screenshot",
      output,
      raw: { output },
    },
  } as never);
  const serialized = JSON.stringify(event);
  assert.equal(event.type, "tool");
  assert.equal(serialized.includes(base64), false);
  assert.match(serialized, /"type":"screenshot_ref"/);
});

test("the provider request carries the screenshot as an image block", async () => {
  const output = previewToolModelOutput(screenshotResult());
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "shot-1",
          name: "preview_devtools__take_screenshot",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "shot-1",
          name: "preview_devtools__take_screenshot",
          content: output,
        },
      ],
    },
  ] as unknown as Message[];
  let body: Record<string, unknown> | undefined;
  const handler = createHandler({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    apiKey: "offline-placeholder",
    baseUrl: "https://offline.invalid",
    fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        '{"type":"error","error":{"type":"invalid_request_error","message":"Offline capture"}}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  } as never);
  try {
    for await (const part of handler.createMessage("Look.", messages, []))
      void part;
  } catch (error) {
    assert.match(String(error), /Offline capture/);
  }
  assert.ok(body, "Missing offline provider request");
  const request = JSON.stringify(body.messages);
  assert.match(request, /"type":"image"/);
  assert.match(request, /"media_type":"image\/png"/);
  assert.equal(request.split(base64).length - 1, 1);
  assert.equal(request.includes("blameScreenshot"), false);
});
