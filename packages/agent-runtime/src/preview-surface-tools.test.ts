import assert from "node:assert/strict";
import test from "node:test";
import {
  previewDevtoolsMcpTools,
  previewDevtoolsTool,
  type PreviewRuntimeContext,
} from "./preview-harness-tools.js";
import { boundedSurfaceArguments } from "./preview-surface-tools.js";

test("offers the selected surface tool without browser tools", async () => {
  const context: PreviewRuntimeContext = { worktree: "/work", storyId: "s" };
  const calls: unknown[] = [];
  const options = {
    previewSurfaceInfo: async () => ({
      type: "terminal" as const,
      serviceId: "cli",
    }),
    previewSurfaceCall: async (input: unknown) => {
      calls.push(input);
      return { status: "ready", text: "hello" };
    },
  };
  const tools = await previewDevtoolsMcpTools(options, context, { log() {} });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["preview_terminal"],
  );
  assert.equal(previewDevtoolsTool(options, context), undefined);
  await tools[0]!.execute({ action: "read" }, {
    signal: new AbortController().signal,
  } as never);
  assert.equal(calls.length, 1);
});
test("surface tool arguments cannot bypass bounds", () => {
  assert.throws(() => boundedSurfaceArguments({ pattern: "x".repeat(201) }));
  assert.throws(() => boundedSurfaceArguments({ timeoutMs: 60001 }));
  assert.throws(() => boundedSurfaceArguments({ text: "x".repeat(71000) }));
});
