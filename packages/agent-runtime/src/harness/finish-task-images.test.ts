import assert from "node:assert/strict";
import test from "node:test";
import { createFinishTaskTool } from "./finish-task.js";
import {
  finishImages,
  type LightCompletionNotification,
} from "./light-completion.js";
import { finishTaskInputSchema } from "./light-contracts.js";
import {
  recordSessionScreenshots,
  sessionScreenshotIds,
} from "../preview-screenshots.js";

const first = "1".repeat(64);
const second = "2".repeat(64);
const context = { sessionId: "session-1", toolCallId: "finish-1" } as never;

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

function remoteFinish(
  known: string[],
  completions: LightCompletionNotification[],
  executed: unknown[],
) {
  return createFinishTaskTool({
    conversationId: "session-1",
    executor: async (request) => {
      executed.push(request.input);
      return {
        status: "ok",
        data: {
          notification: {
            completion: { status: "verified" },
            submission_outcome: "accepted",
            summary: "Done.",
            verified: true,
          },
          summary: "Done.",
        },
      } as never;
    },
    onComplete: (notification) => {
      completions.push(notification);
    },
    screenshots: {
      unknown: async (ids) => ids.filter((id) => !known.includes(id)),
    },
    workspaceRoot: "/workspace",
  });
}

test("images reach the completion in the agent's order", async () => {
  const completions: LightCompletionNotification[] = [];
  const executed: unknown[] = [];
  const tool = remoteFinish([first, second], completions, executed);
  await tool.execute(
    {
      summary: "Done.",
      images: [
        { ref: `screenshot:${second}`, caption: "Dark" },
        { ref: `screenshot:${first}`, caption: "Light" },
        { ref: `screenshot:${second}`, caption: "Dark again" },
      ],
    },
    context,
  );
  assert.deepEqual(completions[0].images, [
    { caption: "Dark", id: second },
    { caption: "Light", id: first },
  ]);
  assert.deepEqual((executed[0] as { images: unknown[] }).images.length, 2);
});

test("an unknown screenshot fails the call with a clear message", async () => {
  const completions: LightCompletionNotification[] = [];
  const executed: unknown[] = [];
  const tool = remoteFinish([first], completions, executed);
  await assert.rejects(
    Promise.resolve(
      tool.execute(
        {
          summary: "Done.",
          images: [
            { ref: `screenshot:${first}`, caption: "Light" },
            { ref: `screenshot:${second}`, caption: "Taken elsewhere" },
          ],
        },
        context,
      ),
    ),
    new RegExp(`Unknown: screenshot:${second}`),
  );
  assert.deepEqual(completions, []);
  assert.deepEqual(executed, []);
});

test("a finish without images is unchanged", async () => {
  const completions: LightCompletionNotification[] = [];
  const tool = remoteFinish([], completions, []);
  await tool.execute({ summary: "Done." }, context);
  assert.equal("images" in completions[0], false);
});
