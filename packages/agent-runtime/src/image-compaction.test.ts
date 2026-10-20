import assert from "node:assert/strict";
import test from "node:test";
import { createContextCompactionPrepareTurn, splitCoreSessionConfig, type CoreCompactionConfig, type Message } from "@cline/sdk";
import { imageAwareCompaction } from "./image-compaction.js";

const image = { type: "image", mediaType: "image/png", data: "A".repeat(600_000) };

function imageMessages(): Message[] {
  return [{ role: "user", content: "Inspect these inputs." }, ...Array.from({ length: 6 }, (_, index) => [
    { role: "assistant", content: [{ type: "tool_use", id: `read-${index}`, name: "read_code", input: { target: `${index}.png` } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `read-${index}`, content: [{ ...image }] }] },
  ]).flat()];
}

async function compact(messages: Message[], config: CoreCompactionConfig, maxInputTokens = 922_000) {
  const prepare = createContextCompactionPrepareTurn({ compaction: config, providerId: "anthropic", modelId: "fixture" });
  assert.ok(prepare);
  return prepare({ abortSignal: new AbortController().signal, agentId: "fixture", conversationId: "fixture",
    parentAgentId: null, iteration: 1, messages, apiMessages: messages, systemPrompt: "", tools: [],
    model: { id: "fixture", provider: "anthropic", info: { maxInputTokens, contextWindow: maxInputTokens + 128_000 } },
  });
}

function configured() {
  return imageAwareCompaction({ enabled: true, strategy: "basic" }, "openai-codex", "gpt-5.6-luna");
}

test("documented model families receive the conservative image bound", () => {
  for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-luna-2026-09-01"])
    assert.equal(imageAwareCompaction({}, "openai-codex", model).imageTokenLimit, 36_000);
});

test("unknown providers and models keep their existing estimator", () => {
  const config = { enabled: true };
  assert.equal(imageAwareCompaction(config, "other", "gpt-5.6-luna"), config);
  assert.equal(imageAwareCompaction(config, "openai-codex", "gpt-6-astra"), config);
  assert.equal(imageAwareCompaction(config, "openai-codex", "gpt-5.6-luna-custom"), config);
});

test("disabled compaction and explicit bounds are preserved", () => {
  for (const config of [{ enabled: false }, { imageTokenLimit: 50_000 }])
    assert.equal(imageAwareCompaction(config, "openai-codex", "gpt-5.6-luna"), config);
});

test("session normalization preserves the serializable image bound", () => {
  const { config } = splitCoreSessionConfig({ providerId: "openai-codex", modelId: "gpt-5.6-luna", compaction: configured() });
  assert.equal(config.compaction?.imageTokenLimit, 36_000);
  assert.equal(JSON.parse(JSON.stringify(config)).compaction.imageTokenLimit, 36_000);
});

test("image transport bytes no longer compact a small visual context", async () => {
  const messages = imageMessages();
  const stored = JSON.stringify(messages);
  // Since Cline 0.0.95 the native estimate no longer bills base64 bytes either.
  assert.equal(await compact(messages, { enabled: true, strategy: "basic" }), undefined);
  assert.equal(await compact(messages, configured()), undefined);
  assert.equal(JSON.stringify(messages), stored);
});

test("the image token bound still triggers compaction in a constrained window", async () => {
  assert.ok(await compact(imageMessages(), configured(), 100_000));
});

test("long text compaction matches the native control", async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(1000) }));
  const original = await compact(messages, { enabled: true, strategy: "basic" }, 2000);
  const corrected = await compact(messages, configured(), 2000);
  assert.ok(original && corrected);
  assert.deepEqual(corrected.messages.map(({ role, content }: Message) => ({ role, content })), original.messages.map(({ role, content }: Message) => ({ role, content })));
});

test("image-shaped tool arguments follow Cline's image detection", async () => {
  // Cline 0.0.95 bounds any image-shaped node, tool arguments included. The
  // bound only changes the per-image cost, never which nodes count as images.
  const messages: Message[] = [{ role: "user", content: "Store the payload." },
    { role: "assistant", content: [{ type: "tool_use", id: "store", name: "store", input: { payload: image } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "store", content: "stored" }] },
    { role: "assistant", content: "Completed." }];
  assert.equal(await compact(messages, { enabled: true, strategy: "basic" }, 10_000), undefined);
  assert.ok(await compact(messages, { ...configured(), imageTokenLimit: 20_000 }, 10_000));
});

test("invalid image bounds retain native behavior", async () => {
  const original = await compact(imageMessages(), { enabled: true, strategy: "basic" });
  for (const imageTokenLimit of [0, -1, Infinity, NaN]) {
    const result = await compact(imageMessages(), { enabled: true, strategy: "basic", imageTokenLimit });
    assert.equal(result?.messages.length, original?.messages.length);
  }
});
