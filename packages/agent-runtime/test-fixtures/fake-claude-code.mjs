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
  const content = JSON.parse(line).message.content;
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
