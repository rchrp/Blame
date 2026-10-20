// Smoke test for Cline SDK upgrades: drives one real local session through
// Blame's production configuration against an offline OpenAI-compatible server.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  } finally {
    await core.delete("blame-cline-smoke").catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});

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

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
