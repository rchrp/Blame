import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ClaudeCodeBridge } from "./claude-code-bridge.js";

const fakeClaudeCode = fileURLToPath(
  new URL("../../test-fixtures/fake-claude-code.mjs", import.meta.url),
);

const echoTool = {
  name: "echo",
  description: "Echo a value",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

test("relays turns and holds tool calls until Blame sends results", async () => {
  await withBridge(async (bridge) => {
    const key = bridge.token("session-a");
    const first = { role: "user", content: "please use tool" };
    const toolTurn = await stream(bridge, key, [first]);
    const toolStart = toolTurn.find(
      (event) => event.type === "content_block_start",
    );
    assert.equal(toolStart?.content_block?.name, "echo");
    assert.equal(toolStart?.content_block?.caller, undefined);
    assert.equal(stopReason(toolTurn), "tool_use");

    const toolUse = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "echo", input: { value: "ping" } },
      ],
    };
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "pong" }],
    };
    const answer = await stream(bridge, key, [first, toolUse, toolResult]);
    assert.match(text(answer), /tool said: pong/);
    assert.equal(stopReason(answer), "end_turn");

    const reply = { role: "assistant", content: [{ type: "text", text: text(answer) }] };
    const next = await stream(bridge, key, [
      first,
      toolUse,
      toolResult,
      reply,
      { role: "user", content: "thanks" },
    ]);
    assert.match(text(next), /echo\(sonnet\): thanks/);
    assert.equal(openLanes(bridge), 1);
  });
});

test("replays history in a new Claude Code process when turns do not line up", async () => {
  await withBridge(async (bridge) => {
    const events = await stream(bridge, bridge.token("session-b"), [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
    const output = text(events);
    assert.match(output, /<blame_conversation_history>/);
    assert.match(output, /first answer/);
    assert.match(output, /second question/);
    assert.match(output, /system: You are Blame/);
  });
});

test("answers non-streaming calls and rejects unknown keys", async () => {
  await withBridge(async (bridge) => {
    const response = await post(bridge, bridge.token("session-c"), {
      model: "haiku",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.status, 200);
    const message = (await response.json()) as {
      content: { type: string; text: string }[];
      stop_reason: string;
    };
    assert.equal(message.stop_reason, "end_turn");
    assert.match(message.content[0]!.text, /echo\(haiku\): hello/);

    const forged = await post(bridge, "bcc1.c2Vzc2lvbg.forged", {
      model: "haiku",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(forged.status, 401);
  });
});

test("runs Claude Code with the effort Blame picked", async () => {
  await withBridge(async (bridge) => {
    const response = await fetch(`${bridge.baseUrl("127.0.0.1", "max")}/messages`, {
      method: "POST",
      headers: { "x-api-key": bridge.token("session-e") },
      body: JSON.stringify({
        model: "opus",
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const message = (await response.json()) as { content: { text: string }[] };
    assert.match(message.content[0]!.text, /effort: max/);
  });
});

test("maps Claude Code failures to Anthropic errors", async () => {
  await withBridge(async (bridge) => {
    const response = await post(bridge, bridge.token("session-d"), {
      model: "sonnet",
      stream: true,
      messages: [{ role: "user", content: "please fail" }],
    });
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "rate_limit_error");
  });
});

async function withBridge(run: (bridge: ClaudeCodeBridge) => Promise<void>) {
  chmodSync(fakeClaudeCode, 0o755);
  const stateDirectory = mkdtempSync(join(tmpdir(), "blame-claude-code-"));
  const bridge = await ClaudeCodeBridge.start({
    env: { ...process.env, BLAME_CLAUDE_CODE_PATH: fakeClaudeCode },
    stateDirectory,
  });
  try {
    await run(bridge);
  } finally {
    await bridge.close();
    rmSync(stateDirectory, { force: true, recursive: true });
  }
}

function post(bridge: ClaudeCodeBridge, key: string, body: unknown) {
  return fetch(`${bridge.baseUrl("127.0.0.1")}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
}

type StreamEvent = {
  type: string;
  content_block?: { name?: string; caller?: unknown };
  delta?: { text?: string; stop_reason?: string };
};

async function stream(bridge: ClaudeCodeBridge, key: string, messages: unknown[]) {
  const response = await post(bridge, key, {
    model: "sonnet",
    stream: true,
    system: [{ type: "text", text: "You are Blame." }],
    tools: [echoTool],
    messages,
  });
  assert.equal(response.status, 200);
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
}

function text(events: StreamEvent[]) {
  return events.map((event) => event.delta?.text ?? "").join("");
}

function stopReason(events: StreamEvent[]) {
  return events.find((event) => event.type === "message_delta")?.delta
    ?.stop_reason;
}

function openLanes(bridge: ClaudeCodeBridge) {
  return (bridge as unknown as { lanesById: Map<string, unknown> }).lanesById
    .size;
}
