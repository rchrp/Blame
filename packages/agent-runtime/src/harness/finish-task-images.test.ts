import assert from "node:assert/strict";
import test from "node:test";
import { HarnessProcess } from "./test-client/harness.js";
import { finishImages } from "./test-client/units.js";
import { finishSummaryLimit, finishTaskInputSchema } from "./test-client/contracts.js";
import {
  recordSessionScreenshots,
  sessionScreenshotIds,
} from "../preview-screenshots.js";

const first = "1".repeat(64);
const second = "2".repeat(64);
const harness = new HarnessProcess();

/** finish_task as the engine calls it: what the model reads back. */
function finishCall(input: unknown) {
  return harness.send("call", {
    tool: "finish_task", input, workspaceRoot: "/nonexistent-workspace",
    taskContract: { session_id: "session-1" }, toolContext: { sessionId: "session-1", toolCallId: "finish-1" },
  }) as Promise<{ ok: boolean; content: unknown }>;
}

test("finish_task accepts up to eight captioned screenshot references", () => {
  assert.equal(
    finishTaskInputSchema.safeParse({
      summary: "Done.",
      images: [{ ref: `screenshot:${first}`, caption: "Providers page, dark" }],
    }).success,
    true,
  );
  assert.equal(
    finishTaskInputSchema.safeParse({ summary: "Done." }).success,
    true,
  );
  for (const images of [
    [{ ref: first, caption: "Missing prefix" }],
    [{ ref: `screenshot:${"A".repeat(64)}`, caption: "Upper case" }],
    [{ ref: `screenshot:${first}`, caption: "" }],
    [{ ref: `screenshot:${first}`, caption: "x".repeat(161) }],
    [{ ref: `screenshot:${first}`, caption: "Extra", url: "x" }],
    Array.from({ length: 9 }, () => ({
      ref: `screenshot:${first}`,
      caption: "Too many",
    })),
  ])
    assert.equal(
      finishTaskInputSchema.safeParse({ summary: "Done.", images }).success,
      false,
      JSON.stringify(images).slice(0, 80),
    );
});

test("repeated screenshots are dropped and the order is kept", () => {
  assert.deepEqual(
    finishImages([
      { ref: `screenshot:${second}`, caption: "After" },
      { ref: `screenshot:${first}`, caption: "Before" },
      { ref: `screenshot:${second}`, caption: "After again" },
    ]),
    [
      { caption: "After", id: second },
      { caption: "Before", id: first },
    ],
  );
});

test("the session remembers the screenshots it took", () => {
  recordSessionScreenshots("session-registry", [
    {
      type: "image",
      data: "AAA",
      mediaType: "image/png",
      blameScreenshot: {
        id: first,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    },
  ]);
  assert.ok(sessionScreenshotIds("session-registry").has(first));
  assert.equal(sessionScreenshotIds("another-session").size, 0);
});

// "images reach the completion in the agent's order" and "a finish without
// images is unchanged" drove the Cline runtime's finish tool with its
// session screenshot registry. On the engine the harness knows no
// screenshot of the session and refuses any image, as below; the order and
// de-duplication are the unit above.

test("an unknown screenshot fails the call with a clear message", async () => {
  const result = await finishCall({
    summary: "Done.",
    images: [
      { ref: `screenshot:${first}`, caption: "Light" },
      { ref: `screenshot:${second}`, caption: "Taken elsewhere" },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(String(result.content), new RegExp(`Unknown: screenshot:${first}, screenshot:${second}`));
});

test("a summary over the limit is refused with its length so the agent can shorten it", async () => {
  assert.equal(
    finishTaskInputSchema.safeParse({ summary: "a".repeat(20_000) }).success,
    true,
  );
  const input = { summary: "a".repeat(finishSummaryLimit + 1) };
  const parsed = finishTaskInputSchema.safeParse(input);
  assert.equal(parsed.success, false);
  const refused = await finishCall(input);
  assert.equal(refused.ok, false);
  assert.equal(
    refused.content,
    `finish_task was not accepted: summary is ${finishSummaryLimit + 1} characters, the limit is ${finishSummaryLimit}; shorten it. Fix this and call finish_task again.`,
  );
});
