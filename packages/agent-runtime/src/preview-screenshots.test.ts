import assert from "node:assert/strict";
import test from "node:test";
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
    content: [{ type: "text", text: '- heading "Board" [ref=e1]' }],
    _meta: { previewReadyEvidence: { status: "passed" } },
  };
  assert.equal(previewToolModelOutput(result), result);
});

// "the image context budget sees converted preview screenshots" went with
// image-context.ts, the Cline runtime's provider projection; the engine
// projects its context in Rust.

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

