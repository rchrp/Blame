#!/usr/bin/env node
// Imitates `claude --print --input-format stream-json --output-format
// stream-json`: it streams Anthropic events, and when a prompt asks for a
// tool it calls Blame's MCP endpoint and waits for the result.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const mcpUrl = JSON.parse(option("--mcp-config")).mcpServers.blame.url;
const systemPrompt = readFileSync(option("--system-prompt-file"), "utf8");
const model = option("--model");
const effort = args.includes("--effort") ? option("--effort") : "default";
let messageCount = 0;
let mcpReady;
// Called when Blame interrupts a stream this fake left silent on purpose.
let onInterrupt;

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (value) => write({ type: "stream_event", event: value });

write({
  type: "system",
  subtype: "init",
  model,
  mcp_servers: [{ name: "blame", status: "connected" }],
});

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const input = JSON.parse(line);
  if (input.type === "control_request") {
    write({ type: "control_response", response: { subtype: "success", request_id: input.request_id } });
    if (input.request.subtype === "interrupt") onInterrupt?.();
    onInterrupt = undefined;
    continue;
  }
  const content = input.message.content;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text.includes("use tool")) {
    const id = `toolu_${++messageCount}`;
    streamMessage([
      { type: "tool_use", id, name: "mcp__blame__echo", input: {} },
    ], [{ type: "input_json_delta", partial_json: '{"value":"ping"}' }], "tool_use");
    const result = await callTool(id, { value: "ping" });
    streamText(`tool said: ${result.content.map((item) => item.text).join(" ")}`);
  } else if (text.includes("please cut")) {
    // A dropped connection: Claude Code closes the partial answer, then
    // retries the same request on its own.
    streamPartial("partial");
    write({ type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: 10, error: "unknown" });
    if (text.includes("later")) await new Promise((resolve) => setTimeout(resolve, 300));
    streamText("retried answer");
  } else if (text.includes("please drop")) {
    streamPartial("partial");
    write({ type: "result", subtype: "success", is_error: true, result: "API Error: Connection error." });
    continue;
  } else if (text.includes("please stall")) {
    streamPartial("partial", false);
    onInterrupt = () => {
      event({ type: "content_block_stop", index: 0 });
      event({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } });
      event({ type: "message_stop" });
      write({ type: "result", subtype: "error_during_execution", is_error: true, result: "undefined" });
    };
    continue;
  } else if (text.includes("please hang")) {
    onInterrupt = () =>
      write({ type: "result", subtype: "error_during_execution", is_error: true, result: "undefined" });
    continue;
  } else if (text.includes("fail")) {
    write({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached" });
    continue;
  } else {
    streamText(
      `echo(${model}): ${text} | effort: ${effort} | system: ${systemPrompt.split("\n")[0]}`,
    );
  }
  write({ type: "result", subtype: "success", is_error: false, result: "" });
}

function streamPartial(text, closed = true) {
  event({
    type: "message_start",
    message: { id: `msg_${++messageCount}`, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 3, output_tokens: 1 } },
  });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  if (!closed) return;
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_stop" });
}

function streamText(text) {
  streamMessage([{ type: "text", text: "" }], [{ type: "text_delta", text }], "end_turn");
}

function streamMessage(blocks, deltas, stopReason) {
  event({
    type: "message_start",
    message: { id: `msg_${++messageCount}`, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 3, output_tokens: 1 } },
  });
  blocks.forEach((block, index) => {
    event({ type: "content_block_start", index, content_block: { ...block, caller: { type: "direct" } } });
    for (const delta of deltas) event({ type: "content_block_delta", index, delta });
    event({ type: "content_block_stop", index });
  });
  event({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  event({ type: "message_stop" });
}

async function callTool(toolUseId, input) {
  mcpReady ??= rpc({ method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await mcpReady;
  const listed = await rpc({ method: "tools/list", params: {} });
  if (!listed.result.tools.some((tool) => tool.name === "echo"))
    throw new Error("echo tool is missing");
  const called = await rpc({
    method: "tools/call",
    params: { name: "echo", arguments: input, _meta: { "claudecode/toolUseId": toolUseId } },
  });
  return called.result;
}

async function rpc(body) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.random(), ...body }),
  });
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}
