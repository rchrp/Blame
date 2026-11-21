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

/**
 * Four requests as the engine sent them to its mock model (captured by
 * `crates/blame-engine/tests/call_ids.rs`): two tool calls at once, a message
 * the person added while they ran, one more call, the answer, a second turn.
 * Cache markers move between them, and the first message loses its own.
 */
const engineRequests = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../src/claude-code/fixtures/engine-requests.json", import.meta.url)),
    "utf8",
  ),
) as Array<{ messages: unknown[] }>;

test("a conversation the engine sends keeps one Claude Code process", async () => {
  await withBridge(async (bridge, stateDirectory) => {
    const key = bridge.token("engine-session");
    const turns = [];
    for (const body of engineRequests) {
      const response = await post(bridge, key, body);
      assert.equal(response.status, 200);
      turns.push(await events(response));
    }
    assert.deepEqual(
      turns.map(stopReason),
      ["tool_use", "tool_use", "end_turn", "end_turn"],
    );
    // The results, and the message beside them, reached the same process.
    assert.match(
      text(turns[2]!),
      /seen: preview ran with \{"path":"\/"\} \/ preview ran with \{"path":"\/about"\} also the contact page \/ preview ran with \{"path":"\/contact"\}/,
    );
    assert.match(text(turns[3]!), /echo\(claude-sonnet-4-6\): thanks/);
    const started = (await laneEvents(stateDirectory)).filter(
      (entry) => entry.event === "lane_started",
    );
    assert.equal(started.length, 1, JSON.stringify(started));
    assert.equal(started[0]!.replayed, false);
    assert.equal(openLanes(bridge), 1);
  });
});

test("a changed history still starts a new process", async () => {
  await withBridge(async (bridge, stateDirectory) => {
    const key = bridge.token("engine-session-rewound");
    const [first, second] = engineRequests as Array<{ messages: Array<{ content: unknown }> }>;
    await events(await post(bridge, key, first));
    // A rewind: the first message is not the one this process started from.
    const rewound = structuredClone(second!);
    rewound.messages[0]!.content = [{ type: "text", text: "check the pages again" }];
    await events(await post(bridge, key, rewound));
    const started = (await laneEvents(stateDirectory)).filter(
      (entry) => entry.event === "lane_started",
    );
    assert.deepEqual(
      started.map((entry) => entry.replayed),
      [false, true],
    );
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

const toolUse = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "toolu_1", name: "echo", input: { value: "ping" } },
  ],
};

/** What the client sends after finish_task: the tool result, the user's words and a screenshot. */
const followUpWithScreenshot = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "pong" },
    { type: "text", text: "What's on this image?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
  ],
};

test("sends the images of a follow-up to a Claude Code process that is still running", async () => {
  await withBridge(async (bridge) => {
    const first = { role: "user", content: "please use tool" };
    await stream(bridge, bridge.token("session-images-active"), [first]);
    const answer = await stream(bridge, bridge.token("session-images-active"), [
      first,
      toolUse,
      followUpWithScreenshot,
    ]);
    assert.match(
      text(answer),
      /tool said: pong What's on this image\? \[image image\/png\]/,
    );
    assert.equal(openLanes(bridge), 1);
  });
});

test("sends the images of a follow-up to a restarted Claude Code process", async () => {
  await withBridge(async (bridge, stateDirectory) => {
    const answer = await stream(bridge, bridge.token("session-images-replayed"), [
      { role: "user", content: "look at the screen" },
      toolUse,
      followUpWithScreenshot,
    ]);
    assert.match(text(answer), /<blame_conversation_history>/);
    assert.match(text(answer), /The images of the last message follow\./);
    assert.match(text(answer), / \| images: 1$/);
    assert.equal(
      (await laneEvents(stateDirectory)).find((entry) => entry.event === "lane_started")?.replayed,
      true,
    );
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
  test(`keeps the process when Claude Code retries a dropped stream (${timing} the client asks again)`, async () => {
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
  test(`hands Claude Code the client's reminder when it gave up after a drop (${timing} the client asks again)`, async () => {
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

test("logs why Claude Code answered a tool call itself", async () => {
  await withBridge(async (bridge, stateDirectory) => {
    const answer = await stream(bridge, bridge.token("session-refuse"), [
      { role: "user", content: "please refuse" },
    ]);
    assert.equal(stopReason(answer), "tool_use");
    const events = await laneEvents(stateDirectory);
    const refused = events.find((entry) => entry.event === "tool_error") as { error?: string } | undefined;
    assert.equal(refused?.error, "sent no response for 300s");
    assert.ok(events.some((entry) => entry.event === "lane_closed"));
  });
});

test("the first message waits until Claude Code has listed Blame's tools", async () => {
  await withBridge(async (bridge) => {
    const answer = await stream(bridge, bridge.token("session-slow-mcp"), [{ role: "user", content: "hello" }]);
    assert.match(text(answer), /tools: listed/u);
  }, { env: { FAKE_CLAUDE_MCP_DELAY_MS: "400" } });
});

test("the first message goes anyway when the tools are never listed", async () => {
  await withBridge(async (bridge, stateDirectory) => {
    const answer = await stream(bridge, bridge.token("session-no-mcp"), [{ role: "user", content: "hello" }]);
    assert.match(text(answer), /tools: missing/u);
    const waited = (await laneEvents(stateDirectory)).find((entry) => entry.event === "tools_wait") as { listed?: boolean } | undefined;
    assert.equal(waited?.listed, false);
  }, { env: { FAKE_CLAUDE_MCP_DELAY_MS: "5000" }, toolsWaitMs: 300 });
});

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
      // Once the stream has gone quiet after its first text, the wall clock
      // jumps ahead of the monotonic one, as it does across sleep. A fixed
      // delay would land before that text on a slow runner, since the first
      // message waits for Claude Code to list Blame's tools.
      const sleep = () => {
        Date.now = () => realNow() + 60_000;
      };
      try {
        const cut = await stream(
          bridge,
          bridge.token("session-wake"),
          [{ role: "user", content: "please stall" }],
          sleep,
        );
        assert.equal(text(cut), "partial");
      } finally {
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

test("other workers reach the bridge one worker hosts and close its sessions", async () => {
  await withBridge(async (host, stateDirectory) => {
    const shared = await ClaudeCodeBridge.connect({ stateDirectory });
    assert.equal(host.hosting, true);
    assert.equal(shared.hosting, false);
    assert.equal(shared.baseUrl("127.0.0.1"), host.baseUrl("127.0.0.1"));
    assert.equal(shared.token("session-shared"), host.token("session-shared"));

    const key = shared.token("session-shared");
    await stream(host, key, [{ role: "user", content: "hello" }]);
    await stream(host, shared.token("session-kept"), [{ role: "user", content: "hello" }]);
    assert.equal(host.lanes, 2);

    await shared.closeScopes(["session-shared"]);
    assert.equal(host.lanes, 1);
    await host.close();
    assert.equal(await shared.reachable(), false);
  });
});

test("a worker starting the bridge at the same time as another joins it", async () => {
  await withBridge(async (host, stateDirectory) => {
    const late = await ClaudeCodeBridge.start({ stateDirectory });
    assert.equal(late.hosting, false);
    assert.equal(late.baseUrl("127.0.0.1"), host.baseUrl("127.0.0.1"));
  });
});

test("closes an idle conversation that a newer one of its session replaces", async () => {
  await withBridge(async (bridge) => {
    const key = bridge.token("session-superseded");
    await stream(bridge, key, [{ role: "user", content: "please use tool" }]);
    await stream(bridge, key, [{ role: "user", content: "a subagent" }]);
    // The first one waits for a tool result: it stays.
    assert.equal(openLanes(bridge), 2);

    await stream(bridge, key, [{ role: "user", content: "another subagent" }]);
    assert.equal(openLanes(bridge), 2);
  });
});

async function withBridge(
  run: (bridge: ClaudeCodeBridge, stateDirectory: string) => Promise<void>,
  options: { env?: NodeJS.ProcessEnv; stallMs?: number; toolsWaitMs?: number; wakeStallMs?: number; watchIntervalMs?: number } = {},
) {
  chmodSync(fakeClaudeCode, 0o755);
  const stateDirectory = mkdtempSync(join(tmpdir(), "blame-claude-code-"));
  const { env, ...bridgeOptions } = options;
  const bridge = (await ClaudeCodeBridge.start({
    env: { ...process.env, ...env, BLAME_CLAUDE_CODE_PATH: fakeClaudeCode },
    stateDirectory,
    ...bridgeOptions,
  })) as ClaudeCodeBridge;
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

/** The events of a streamed response. */
async function events(response: Response) {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
}

/** Streams a turn; `onText` runs once, when its first text arrives. */
async function stream(
  bridge: ClaudeCodeBridge,
  key: string,
  messages: unknown[],
  onText?: () => void,
) {
  const response = await post(bridge, key, {
    model: "sonnet",
    stream: true,
    system: [{ type: "text", text: "You are Blame." }],
    tools: [echoTool],
    messages,
  });
  assert.equal(response.status, 200);
  const decoder = new TextDecoder();
  let body = "";
  for await (const chunk of response.body!) {
    body += decoder.decode(chunk, { stream: true });
    if (onText && body.includes('"text_delta"')) {
      onText();
      onText = undefined;
    }
  }
  return body
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
    .map((line) => JSON.parse(line) as { afterWake?: boolean; event: string; replayed?: boolean; scope?: string });
}

function openLanes(bridge: ClaudeCodeBridge) {
  return (bridge as unknown as { lanesById: Map<string, unknown> }).lanesById
    .size;
}
