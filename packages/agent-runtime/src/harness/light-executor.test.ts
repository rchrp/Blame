import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  lightToolContext,
  localLightWorkspaceExecutor,
} from "./test-client/light-executor.js";
import { lightSemanticHarnessTools } from "./test-client/light-tools.js";

test("managed calls preserve compaction identity without transferring the transcript", () => {
  const context = transcriptContext();
  const forwarded = lightToolContext(context);
  assert.equal(forwarded.metadata?.contextGeneration, "compaction:latest-summary");
  assert.equal(forwarded.metadata?.modelSupportsImages, true);
  assert.equal(forwarded.agentId, context.agentId);
  assert.equal(forwarded.sessionId, context.sessionId);
  assert.equal(forwarded.toolCallId, context.toolCallId);
  assert.equal(forwarded.snapshot, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(forwarded)) < 512);
});

test("explicit context generations retain precedence over transcript summaries", () => {
  for (const metadata of [{ contextGeneration: 0 }, { contextEpoch: "epoch-2" }]) {
    const context = { ...transcriptContext(), metadata };
    const forwarded = lightToolContext(context);
    assert.equal(forwarded.metadata?.contextGeneration, String(metadata.contextGeneration ?? metadata.contextEpoch));
  }
});

for (const toolName of ["read_code", "edit_code"]) {
  test(`managed ${toolName} honors cancellation before the requested operation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "blame-relay-cancel-"));
    try {
      await writeFile(join(root, "source.txt"), "original");
      const executor = localLightWorkspaceExecutor(root);
      const tool = lightSemanticHarnessTools(root, { executor }).find((item) => item.name === toolName)!;
      const signal = AbortSignal.abort(new Error("Cancelled by the user"));
      const input = toolName === "read_code" ? { target: "source.txt" }
        : { operations: [{ kind: "patch", path: "created.txt", patch: "new content" }] };
      const result = await tool.execute(input, { agentId: "lead", iteration: 1, signal }) as { status: string; message: string };
      assert.notEqual(result.status, "ok");
      assert.match(result.message, /Cancelled by the user/);
      await assert.rejects(access(join(root, "created.txt")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

// "drops workspaces idle past the limit and keeps one serving a request" and
// "keeps the most recently used workspaces up to the limit" set the cache's
// limits, which a harness process does not take: they are
// crates/blame-harness/tests/protocol.rs's tests of the same names.


/** A tool call's context as the engine's agent loop gives it, with its transcript. */
type AgentToolContext = { agentId: string; iteration: number; sessionId?: string; toolCallId?: string; metadata?: Record<string, unknown>; snapshot?: unknown };

function transcriptContext(): AgentToolContext {
  return {
    agentId: "lead", iteration: 1, sessionId: "session", toolCallId: "call",
    metadata: { modelSupportsImages: true },
    snapshot: { messages: [
      { id: "first-summary", metadata: { kind: "compaction_summary" } },
      { id: "source", content: "earlier source".repeat(100_000) },
      { id: "latest-summary", metadata: { kind: "compaction_summary" }, content: "retained summary" },
    ] },
  };
}
