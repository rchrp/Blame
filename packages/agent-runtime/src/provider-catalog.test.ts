import assert from "node:assert/strict";
import test from "node:test";

import {
  isBaseRuntimeProvider,
  listClineProviders,
} from "./provider-catalog.js";

test("excludes the Codex CLI provider and keeps Claude Code", async () => {
  assert.equal(isBaseRuntimeProvider("openai-codex-cli"), false);
  assert.equal(isBaseRuntimeProvider("claude-code"), true);
  assert.equal(isBaseRuntimeProvider("openai-codex"), true);
  assert.equal(isBaseRuntimeProvider("anthropic"), true);

  const providers = await listClineProviders();
  const providerIds = new Set(providers.map((provider) => provider.id));

  assert.equal(providerIds.has("openai-codex-cli"), false);
  assert.equal(providerIds.has("claude-code"), true);
  assert.equal(providerIds.has("openai-codex"), true);
  assert.equal(providerIds.has("anthropic"), true);
  const codex = providers.find((provider) => provider.id === "openai-codex");
  assert.equal(codex?.models["gpt-5.6-sol"]?.name, "GPT-5.6 Sol");
  assert.deepEqual(codex?.models["gpt-5.6-sol"]?.variants?.max, {
    reasoningEffort: "max",
    thinking: true,
  });
  assert.deepEqual(codex?.models["gpt-5.6-sol"]?.variants?.none, {
    thinking: false,
  });
});
