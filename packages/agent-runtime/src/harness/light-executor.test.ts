import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolContext } from "@cline/sdk";
import {
  cachedLightWorkspaceExecutor,
  lightToolContext,
  localLightWorkspaceExecutor,
  type LightWorkspaceExecutor,
} from "./light-executor.js";
import { lightSemanticHarnessTools } from "./light-tools.js";

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

test("drops workspaces idle past the limit and keeps one serving a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-cached-workspaces-"));
  try {
    const execute = cachedLightWorkspaceExecutor({ idleMs: 300 });
    await command(execute, root, "idle", "echo idle");
    const slow = command(execute, root, "busy", "sleep 1; echo busy");
    await delay(700);
    assert.equal(await runKnown(execute, root, "idle"), false);
    await slow;
    assert.equal(await runKnown(execute, root, "busy"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the most recently used workspaces up to the limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-cached-workspaces-"));
  try {
    const execute = cachedLightWorkspaceExecutor({ limit: 2 });
    for (const session of ["a", "b", "c"]) await command(execute, root, session, "echo ok");
    assert.equal(await runKnown(execute, root, "a"), false);
    assert.equal(await runKnown(execute, root, "c"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function command(execute: LightWorkspaceExecutor, root: string, session: string, text: string) {
  return execute({
    input: { kind: "command", command: text },
    taskContract: { session_id: session, environment: { isolated: true, managedPreview: false } },
    tool: "run_task",
    toolContext: { sessionId: session, toolCallId: `${session}-command` },
    workspaceRoot: root,
  });
}

/** Whether the session's workspace still knows its first run. */
async function runKnown(execute: LightWorkspaceExecutor, root: string, session: string) {
  const result = await execute({
    input: { kind: "inspect", run: "r1", until: "now" },
    taskContract: { session_id: session, environment: { isolated: true, managedPreview: false } },
    tool: "run_task",
    toolContext: { sessionId: session, toolCallId: `${session}-inspect` },
    workspaceRoot: root,
  });
  return result.status === "ok";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transcriptContext(): AgentToolContext {
  return {
    agentId: "lead", iteration: 1, sessionId: "session", toolCallId: "call",
    metadata: { modelSupportsImages: true },
    snapshot: { messages: [
      { id: "first-summary", metadata: { kind: "compaction_summary" } },
      { id: "source", content: "earlier source".repeat(100_000) },
      { id: "latest-summary", metadata: { kind: "compaction_summary" }, content: "retained summary" },
    ] } as unknown as AgentToolContext["snapshot"],
  };
}
