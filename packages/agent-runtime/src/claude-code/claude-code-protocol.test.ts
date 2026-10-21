import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeArguments, parseAuthStatus } from "./claude-code-cli.js";
import type { ModelInfo } from "@cline/llms";

import { claudeCodeModelConfig } from "./claude-code-provider.js";
import {
  clientStreamEvent,
  collectMessage,
  initialUserContent,
  laneSignature,
  mcpToolResult,
  parseMessagesRequest,
  requestEffort,
} from "./claude-code-protocol.js";

test("parses the Messages request Cline sends and keeps custom tools only", () => {
  const request = parseMessagesRequest({
    model: "sonnet",
    stream: true,
    system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "read_files", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" },
    ],
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(request.stream, true);
  assert.deepEqual(request.tools?.map((tool) => tool.name), ["read_files"]);
  assert.throws(() =>
    parseMessagesRequest({
      model: "sonnet",
      messages: [{ role: "assistant", content: "Hi" }],
    }),
  );
});

test("maps reasoning settings onto Claude Code effort levels", () => {
  const base = { model: "opus", messages: [{ role: "user" as const, content: "x" }] };
  assert.equal(requestEffort({ ...base, output_config: { effort: "max" } }), "max");
  assert.equal(
    requestEffort({ ...base, thinking: { type: "enabled", budget_tokens: 20_000 } }),
    "high",
  );
  assert.equal(requestEffort({ ...base, thinking: { type: "disabled" } }), undefined);
  assert.notEqual(
    laneSignature({ ...base, output_config: { effort: "low" } }),
    laneSignature({ ...base, output_config: { effort: "high" } }),
  );
});

test("sends a new conversation natively and replays a longer one", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAA" },
  };
  assert.deepEqual(
    initialUserContent([{ role: "user", content: [{ type: "text", text: "Hi" }, image] }]),
    [{ type: "text", text: "Hi" }, image],
  );
  const replay = initialUserContent([
    { role: "user", content: "Fix it" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read_files", input: { path: "a" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
    },
  ]);
  assert.equal(replay.length, 1);
  const transcript = String(replay[0]!.text);
  assert.match(transcript, /\[tool call t1: read_files\] \{"path":"a"\}/);
  assert.match(transcript, /file body/);
  assert.match(transcript, /Continue the task from the last tool results/);
});

test("converts tool results and stream events between both sides", () => {
  assert.deepEqual(
    mcpToolResult(
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: [
          { type: "text", text: "failed" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
      "User note",
    ),
    {
      content: [
        { type: "text", text: "failed" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: "User note" },
      ],
      isError: true,
    },
  );
  const event = clientStreamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "t1", name: "mcp__blame__read_files", input: {}, caller: {} },
  });
  assert.deepEqual(event.content_block, {
    type: "tool_use",
    id: "t1",
    name: "read_files",
    input: {},
  });
  const message = collectMessage([
    { type: "message_start", message: { id: "m", role: "assistant", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "x", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  ]);
  assert.deepEqual(message.content, [{ type: "tool_use", id: "t1", name: "x", input: { a: 1 } }]);
  assert.equal((message as Record<string, unknown>).stop_reason, "tool_use");
});

test("runs Claude Code as a model only, with Blame's tools over MCP", () => {
  const args = claudeCodeArguments({
    effort: "high",
    mcpUrl: "http://127.0.0.1:1/mcp/lane/secret",
    model: "opus",
    systemPromptFile: "/tmp/prompt.md",
  });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), {
    loggedIn: true,
    authMethod: "claude.ai",
    email: undefined,
    subscriptionType: "max",
  });
  assert.deepEqual(parseAuthStatus("not json"), { loggedIn: false });
});

test("sends Claude Code models through Cline's Anthropic provider at no token cost", () => {
  const config = claudeCodeModelConfig<{
    providerId: string;
    modelId: string;
    knownModels?: Record<string, ModelInfo>;
  }>({ providerId: "claude-code", modelId: "sonnet" });
  assert.equal(config.providerId, "anthropic");
  assert.equal(config.knownModels?.sonnet?.pricing?.input, 0);
  assert.ok((config.knownModels?.sonnet?.contextWindow ?? 0) > 0);
  const other = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
  assert.equal(claudeCodeModelConfig(other), other);
});
