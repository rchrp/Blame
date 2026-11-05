import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    assert.match(text(next), /mcp: blame/);
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
    // A request without tools gets no MCP server, so no tool to call.
    assert.match(message.content[0]!.text, /mcp: none/);

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

const reminder = {
  role: "user",
  content: "Previous turn ended unexpectedly. Continue from where you left off.",
};
const partialAnswer = { role: "assistant", content: [{ type: "text", text: "partial" }] };

for (const timing of ["before", "after"]) {
  test(`keeps the process when Claude Code retries a dropped stream (${timing} Cline asks again)`, async () => {
    await withBridge(async (bridge, stateDirectory) => {
      const key = bridge.token(`session-cut-${timing}`);
      const first = { role: "user", content: timing === "before" ? "please cut" : "please cut later" };
      const cut = await stream(bridge, key, [first]);
      assert.equal(text(cut), "partial");
      assert.equal(stopReason(cut), undefined);

      const retried = await stream(bridge, key, [first, partialAnswer, reminder]);
      assert.equal(text(retried), "retried answer");
      assert.equal(stopReason(retried), "end_turn");
      assert.equal(openLanes(bridge), 1);
      assert.deepEqual(
        (await laneEvents(stateDirectory)).map((entry) => entry.event),
        ["lane_started", "turn_cut", "api_retry", "turn_resumed"],
      );
    });
  });
}

for (const timing of ["before", "after"] as const) {
  test(`hands Claude Code Cline's reminder when it gave up after a drop (${timing} Cline asks again)`, async () => {
    await withBridge(async (bridge) => {
      const key = bridge.token(`session-drop-${timing}`);
      const first = { role: "user", content: timing === "before" ? "please drop" : "please drop later" };
      assert.equal(text(await stream(bridge, key, [first])), "partial");
      const next = await stream(bridge, key, [first, partialAnswer, reminder]);
      assert.match(text(next), /echo\(sonnet\): Previous turn ended unexpectedly/);
      assert.equal(openLanes(bridge), 1);
    });
  });
}

test("interrupts a silent stream and continues in the same process", async () => {
  await withBridge(
    async (bridge, stateDirectory) => {
      const key = bridge.token("session-stall");
      const first = { role: "user", content: "please stall" };
      const cut = await stream(bridge, key, [first]);
      assert.equal(text(cut), "partial");
      // Claude Code reports an interrupted answer with a null stop reason.
      assert.equal(stopReason(cut), null);
      const next = await stream(bridge, key, [first, partialAnswer, reminder]);
      assert.match(text(next), /echo\(sonnet\): Previous turn ended unexpectedly/);
      assert.equal(openLanes(bridge), 1);
      const interrupted = (await laneEvents(stateDirectory)).find(
        (entry) => entry.event === "stream_interrupted",
      );
      assert.equal(interrupted?.scope, "session-stall");
    },
    { stallMs: 200, watchIntervalMs: 50 },
  );
});

test("interrupts a silent stream sooner after the computer wakes from sleep", async () => {
  const realNow = Date.now;
  await withBridge(
    async (bridge, stateDirectory) => {
      // The wall clock jumps ahead of the monotonic one, as it does across sleep.
      const asleep = setTimeout(() => {
        Date.now = () => realNow() + 60_000;
      }, 100);
      try {
        const cut = await stream(bridge, bridge.token("session-wake"), [
          { role: "user", content: "please stall" },
        ]);
        assert.equal(text(cut), "partial");
      } finally {
        clearTimeout(asleep);
        Date.now = realNow;
      }
      const events = await laneEvents(stateDirectory);
      assert.ok(events.some((entry) => entry.event === "system_woke"));
      assert.equal(
        events.find((entry) => entry.event === "stream_interrupted")?.afterWake,
        true,
      );
    },
    { stallMs: 60_000, wakeStallMs: 200, watchIntervalMs: 50 },
  );
});

test("retries a turn whose stream stayed silent before any output", async () => {
  await withBridge(
    async (bridge) => {
      const answer = await stream(bridge, bridge.token("session-hang"), [
        { role: "user", content: "please hang" },
      ]);
      assert.match(text(answer), /echo\(sonnet\): The connection to the model dropped/);
      assert.equal(stopReason(answer), "end_turn");
    },
    { stallMs: 200, watchIntervalMs: 50 },
  );
});

async function withBridge(
  run: (bridge: ClaudeCodeBridge, stateDirectory: string) => Promise<void>,
  options: { stallMs?: number; wakeStallMs?: number; watchIntervalMs?: number } = {},
) {
  chmodSync(fakeClaudeCode, 0o755);
  const stateDirectory = mkdtempSync(join(tmpdir(), "blame-claude-code-"));
  const bridge = await ClaudeCodeBridge.start({
    env: { ...process.env, BLAME_CLAUDE_CODE_PATH: fakeClaudeCode },
    stateDirectory,
    ...options,
  });
  try {
    await run(bridge, stateDirectory);
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
  delta?: { text?: string; stop_reason?: string | null };
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

/** The bridge's event log; writes are queued, so give them a moment to land. */
async function laneEvents(stateDirectory: string) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return readFileSync(join(stateDirectory, "bridge-events.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { afterWake?: boolean; event: string; scope?: string });
}

function openLanes(bridge: ClaudeCodeBridge) {
  return (bridge as unknown as { lanesById: Map<string, unknown> }).lanesById
    .size;
}
