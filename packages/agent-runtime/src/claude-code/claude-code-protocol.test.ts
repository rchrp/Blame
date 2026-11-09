import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeArguments, parseAuthStatus } from "./claude-code-cli.js";
import type { ModelInfo } from "@cline/llms";

import { claudeCodeModelConfig } from "./claude-code-provider.js";
import { lightCompletionDescription } from "../harness/light-completion.js";
import {
  classifyClaudeCodeError,
  clientStreamEvent,
  collectMessage,
  contentBesideToolResults,
  initialUserContent,
  laneSignature,
  mcpToolResult,
  parseMessagesRequest,
  requestEffort,
  systemPromptForClaudeCode,
} from "./claude-code-protocol.js";
import { withoutCommitHash } from "../workspace-prompt-metadata.js";

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

test("carries the personalization to Claude Code through the system prompt and the finish_task description", () => {
  const request = (
    system: string,
    personalization: Parameters<typeof lightCompletionDescription>[0],
  ) => ({
    model: "opus",
    system,
    messages: [{ role: "user" as const, content: "x" }],
    tools: [
      {
        name: "finish_task",
        description: lightCompletionDescription(personalization),
        input_schema: { type: "object" },
      },
    ],
  });
  const detailed = request("System", "detailed");
  assert.ok(
    systemPromptForClaudeCode(request("System\n\n## Personalization", "balanced")).includes(
      "## Personalization",
    ),
  );
  assert.ok(detailed.tools[0]!.description.includes("Final reply style: detailed"));
  // A new setting is a new lane, never a change in the middle of a turn.
  assert.notEqual(laneSignature(detailed), laneSignature(request("System", "balanced")));
  assert.notEqual(laneSignature(detailed), laneSignature(request("System", "concise")));
  assert.equal(laneSignature(detailed), laneSignature(request("System", "detailed")));
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
  assert.doesNotMatch(transcript, /images of the last message/);
});

test("a replayed history keeps the images of the last turn and shows older ones as [image]", () => {
  const image = (data: string) => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  });
  const toolUse = (id: string) => ({
    role: "assistant" as const,
    content: [{ type: "tool_use", id, name: "read_files", input: {} }],
  });
  const content = initialUserContent([
    { role: "user", content: [{ type: "text", text: "Plan it" }, image("OLD")] },
    toolUse("t1"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "first body" }] },
    toolUse("t2"),
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "shot" }, image("FROM_TOOL")],
        },
        { type: "text", text: "What's on this image?" },
        image("NEW"),
      ],
    },
  ]);
  assert.equal(content.length, 3);
  const transcript = String(content[0]!.text);
  assert.match(transcript, /Plan it\n\[image\]/);
  assert.match(transcript, /What's on this image\?\n\[image\]/);
  assert.match(transcript, /The images of the last message follow\./);
  assert.doesNotMatch(transcript, /OLD|NEW|FROM_TOOL/);
  assert.deepEqual(content.slice(1), [image("FROM_TOOL"), image("NEW")]);
});

test("the text and images beside tool results travel with the results", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } };
  const besideImage = { type: "image" as const, data: "BBB", mimeType: "image/jpeg" };
  const message = {
    role: "user" as const,
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "done" },
      { type: "text", text: "First" },
      image,
      { type: "text", text: "Second" },
    ],
  };
  const beside = contentBesideToolResults(message);
  assert.deepEqual(beside, [{ type: "text", text: "First\n\nSecond" }, besideImage]);
  assert.deepEqual(mcpToolResult(message.content[0]!, beside).content, [
    { type: "text", text: "done" },
    ...beside,
  ]);
  assert.deepEqual(
    contentBesideToolResults({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }),
    [],
    "Nothing beside the results adds nothing.",
  );
  assert.deepEqual(
    contentBesideToolResults({
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
    }),
    [],
    "An image Blame cannot read inline is skipped.",
  );
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
      [{ type: "text", text: "User note" }],
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
  assert.deepEqual(
    mcpToolResult({
      type: "tool_result",
      tool_use_id: "t2",
      content: [
        { type: "text", text: '{"format":"blame_tool_result_v2"}' },
        { type: "text", text: "data.output:\n```\nok\n```" },
      ],
    }).content,
    [{ type: "text", text: '{"format":"blame_tool_result_v2"}\n\ndata.output:\n```\nok\n```' }],
    "A harness result's parts read as paragraphs of one text.",
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
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__blame");
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), {
    loggedIn: true,
    authMethod: "claude.ai",
    email: undefined,
    subscriptionType: "max",
  });
  assert.deepEqual(parseAuthStatus("not json"), { loggedIn: false });
});

test("a request without tools starts Claude Code without Blame's MCP server or tool notes", () => {
  const args = claudeCodeArguments({ model: "haiku", systemPromptFile: "/tmp/prompt.md" });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!), { mcpServers: {} });
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--allowedTools"));
  const prompt = systemPromptForClaudeCode({
    model: "haiku",
    messages: [{ role: "user", content: "Read the README." }],
    system: "# Blame Title Generator",
    tools: [],
  });
  assert.match(prompt, /^# Blame Title Generator/u);
  assert.match(prompt, /You have no tools here/u);
  assert.doesNotMatch(prompt, /mcp__blame__|read_code|search_code/u);
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

test("Claude Code learns that Blame's tools replace its own shell and file tools", () => {
  const prompt = systemPromptForClaudeCode({
    model: "opus",
    messages: [],
    system: "# Blame",
    tools: [{ name: "read_code", input_schema: { type: "object" } }],
  });
  assert.match(prompt, /^# Blame/u);
  assert.match(prompt, /`search_code` is the grep/u);
  assert.match(prompt, /several tool calls in one response/u);
});

test("workspace metadata in the prompt leaves out the commit hash so commits keep the prompt cache", () => {
  const metadata = JSON.stringify({ workspaces: { "/repo": { hint: "repo", latestGitCommitHash: "abc123", latestGitBranchName: "main" } } }, null, 2);
  assert.deepEqual(JSON.parse(withoutCommitHash(metadata)), { workspaces: { "/repo": { hint: "repo", latestGitBranchName: "main" } } });
  assert.equal(withoutCommitHash("plain text"), "plain text");
});

test("an expired Claude Code sign-in is an authentication error, not a retried server error", () => {
  for (const message of [
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "OAuth token has expired",
    "Invalid API key · Please run /login",
  ])
    assert.deepEqual(classifyClaudeCodeError(message), { status: 401, type: "authentication_error" });
  assert.equal(classifyClaudeCodeError("socket hang up").status, 500);
});
