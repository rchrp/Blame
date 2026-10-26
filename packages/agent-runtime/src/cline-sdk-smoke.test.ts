// Smoke test for Cline SDK upgrades: drives one real local session through
// Blame's production configuration against an offline OpenAI-compatible server.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "blame-cline-smoke-"));
// Cline persists sessions below the home directory; keep them out of the user's.
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const { ClineCore } = await import("@cline/sdk");
const { appendProductionConfig } = await import("./production.js");
const { createProviderCompatibleFetch } = await import(
  "./provider-schema-compatibility.js"
);
const { listClineProviders } = await import("./provider-catalog.js");
const { toolPolicies } = await import("./cline-runtime-configuration.js");
const { attachmentTools } = await import("./attachment-tools.js");
const { reasoningConfig } = await import("./reasoning.js");
const { developmentUserInput, newAttachmentDirectory } = await import("./cline-runtime-prompts.js");

test.after(() => rm(sandbox, { force: true, recursive: true }));

test("Cline exposes the providers Blame relies on, with models", async () => {
  const providers = await listClineProviders();
  for (const id of [
    "anthropic",
    "gemini",
    "openai-codex",
    "openai-compatible",
    "openai-native",
    "openrouter",
  ]) {
    const provider = providers.find((candidate) => candidate.id === id);
    assert.ok(provider, `Cline no longer provides ${id}`);
    if (id !== "openai-compatible") {
      assert.ok(
        Object.keys(provider.models).length > 0,
        `${id} has no bundled models`,
      );
    }
  }
});

test("a Blame-configured Cline session completes a streamed turn", async () => {
  const requests: Array<{ body: Record<string, unknown>; url?: string }> = [];
  const server = createServer(async (request, response) => {
    requests.push({ body: JSON.parse(await readBody(request)), url: request.url });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of streamedCompletion(["po", "ng"])) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const workspace = await mkdtemp(join(sandbox, "workspace-"));
  const core = await ClineCore.create({
    backendMode: "local",
    clientName: "blame-smoke",
    fetch: createProviderCompatibleFetch(globalThis.fetch),
    toolPolicies: toolPolicies(false),
  });
  try {
    const started = await core.start({
      prompt: "ping",
      config: appendProductionConfig({
        sessionId: "blame-cline-smoke",
        providerId: "openai-compatible",
        modelId: "smoke-model",
        apiKey: "offline",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        cwd: workspace,
        workspaceRoot: workspace,
        checkpoint: { enabled: false },
        enableAgentTeams: false,
        enableSpawnAgent: false,
        enableTools: false,
        maxIterations: 1,
        mode: "act",
        systemPrompt: "Reply with pong.",
        ...reasoningConfig("max"),
      }),
      interactive: false,
      source: "blame-smoke",
    });
    const result = started.result;
    assert.ok(result, "Cline returned no session result");
    assert.equal(result.text, "pong");
    assert.notEqual(result.finishReason, "error");
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/v1/chat/completions");
    assert.equal(requests[0]!.body.model, "smoke-model");
    assert.equal(requests[0]!.body.stream, true);
    assert.equal(requests[0]!.body.reasoning_effort, "max");
  } finally {
    await core.delete("blame-cline-smoke").catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reattaching during a streamed turn preserves the live run and rejects a second prompt", { timeout: 15_000 }, async () => {
  const received = deferred();
  const finish = deferred();
  let requests = 0;
  const server = createServer(async (request, response) => {
    await readBody(request);
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    received.resolve();
    await finish.promise;
    for (const chunk of streamedCompletion(["pong"])) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const workspace = await mkdtemp(join(sandbox, "reattach-workspace-"));
  const core = await ClineCore.create({ backendMode: "local", clientName: "reattach-smoke", fetch: createProviderCompatibleFetch(globalThis.fetch) });
  const config = appendProductionConfig({
    sessionId: "reattach-smoke", providerId: "openai-compatible", modelId: "smoke-model", apiKey: "offline",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, cwd: workspace, workspaceRoot: workspace,
    checkpoint: { enabled: false }, enableTools: false, enableAgentTeams: false, enableSpawnAgent: false,
    maxIterations: 1, mode: "act", systemPrompt: "Reply with pong.",
  });
  const running = core.start({ config, prompt: "ping", interactive: false });
  // Observe startup failures while waiting for the offline server.
  void running.catch(received.reject);
  try {
    await received.promise;
    const attached = await core.start({ config, interactive: true });
    assert.equal(attached.sessionId, config.sessionId);
    await assert.rejects(core.start({ config, prompt: "second prompt", interactive: false }), /already has a run in progress/);
    finish.resolve();
    assert.equal((await running).result?.text, "pong");
    assert.equal(requests, 1, "reattaching must not launch another model request");
    const messages = await core.readMessages(config.sessionId!);
    assert.match(JSON.stringify(messages), /pong/);
    assert.doesNotMatch(JSON.stringify(messages), /second prompt/);
  } finally {
    finish.resolve();
    await core.stop(config.sessionId!).catch(() => undefined);
    await running.catch(() => undefined);
    await core.delete(config.sessionId!).catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function streamedCompletion(parts: string[]) {
  const base = { id: "smoke", object: "chat.completion.chunk", created: 0, model: "smoke-model" };
  return [
    ...parts.map((content, index) => ({
      ...base,
      choices: [{ index: 0, delta: index ? { content } : { role: "assistant", content }, finish_reason: null }],
    })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
  ];
}

test("an attached PDF reaches the model through the real SDK read tool", async () => {
  const workspace = await mkdtemp(join(sandbox, "attachment-workspace-"));
  const bytes = await readFile(new URL("../src/fixtures/attachments/report.pdf", import.meta.url));
  const input = await developmentUserInput({
    title: "Read the report", summary: "What is the revenue?",
    fileAttachments: [{ name: "report.pdf", type: "application/pdf", size: bytes.length, content: bytes.toString("base64") }],
  }, newAttachmentDirectory(workspace));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    requests.push(JSON.parse(await readBody(request)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunks = requests.length === 1 ? [
      { id: "attachment", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-attachment", type: "function", function: { name: "read_attachment", arguments: JSON.stringify({ path: input.userFiles[0] }) } }] }, finish_reason: null }] },
      { id: "attachment", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ] : streamedCompletion(["42 EUR"]);
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const core = await ClineCore.create({ backendMode: "local", clientName: "attachment-smoke", fetch: createProviderCompatibleFetch(globalThis.fetch), toolPolicies: toolPolicies(false) });
  try {
    const started = await core.start({
      prompt: input.prompt,
      config: appendProductionConfig({
        sessionId: "attachment-smoke", providerId: "openai-compatible", modelId: "smoke-model", apiKey: "offline",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, cwd: workspace, workspaceRoot: workspace,
        checkpoint: { enabled: false }, enableAgentTeams: false, enableSpawnAgent: false,
        enableTools: true, extraTools: attachmentTools(workspace), maxIterations: 3, mode: "act", systemPrompt: "Read the attachment and answer.",
      }),
      interactive: false, source: "attachment-smoke",
    });
    assert.equal(started.result?.text, "42 EUR");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests[0]), /Error fetching content|Cannot read binary/);
    const messages = requests[1]!.messages as Array<{ role: string; content: unknown }>;
    const result = messages.find(message => message.role === "tool");
    assert.ok(result, "No document tool result was forwarded to the model");
    assert.match(JSON.stringify(result.content), /revenue is 42 EUR/);
  } finally {
    await core.delete("attachment-smoke").catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
  }
});

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
