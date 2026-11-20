import assert from "node:assert/strict";
import { it } from "node:test";
import type { ModelCatalog, ModelInfo } from "@blame/engine-client";
import type { ProviderCredentialSummary } from "../types.js";
import { providerList, reasoningChoices } from "./provider-list.js";

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id.toUpperCase(),
    images: true,
    pdf: false,
    reasoning: {
      supported: true,
      efforts: ["low", "high", "max"],
      can_disable: false,
    },
    ...extra,
  };
}

const catalog: ModelCatalog = {
  source: "models_dev",
  fetched_at_ms: 1,
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      auth: "api_key",
      needs_base_url: false,
      sources: ["anthropic"],
      models: [
        model("claude-brand-new-1", {
          context_window: 2_000_000,
          max_output_tokens: 64_000,
          release_date: "2026-11-20",
          price: { input: 10_000_000, output: 40_000_000 },
        }),
        model("claude-older"),
      ],
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      auth: "subscription",
      needs_base_url: false,
      sources: ["openai"],
      models: [model("gpt-next")],
    },
    {
      id: "openai-compatible",
      name: "OpenAI-compatible",
      auth: "optional",
      needs_base_url: true,
      sources: [],
      models: [],
    },
  ],
};

function credential(
  providerId: string,
  label: string,
  modelIds?: string[],
): ProviderCredentialSummary {
  return {
    id: `${providerId}-${label}`,
    userId: "user",
    providerId,
    label,
    baseUrl:
      providerId === "openai-compatible" ? "http://127.0.0.1:1/v1" : null,
    ...(modelIds ? { modelIds } : {}),
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: null,
  };
}

it("offers the engine's models, by its provider ids, with what the pickers read", () => {
  const list = providerList({
    catalog,
    credentials: [
      credential("anthropic", "default"),
      credential("chatgpt", "work"),
    ],
  });
  assert.deepEqual(
    list.all.map((provider) => provider.id),
    ["anthropic", "chatgpt", "openai-compatible"],
  );
  assert.deepEqual(list.connected, ["anthropic", "chatgpt"]);
  const anthropic = list.all[0]!;
  // Newest first, as the engine lists them.
  assert.deepEqual(Object.keys(anthropic.models), [
    "claude-brand-new-1",
    "claude-older",
  ]);
  const brandNew = anthropic.models["claude-brand-new-1"]!;
  assert.equal(brandNew.contextWindow, 2_000_000);
  assert.equal(brandNew.maxTokens, 64_000);
  assert.equal(brandNew.releaseDate, "2026-11-20");
  // USD per million tokens.
  assert.deepEqual([brandNew.cost.input, brandNew.cost.output], [10, 40]);
  assert.deepEqual(Object.keys(brandNew.variants ?? {}), [
    "low",
    "high",
    "max",
  ]);
  assert.ok(brandNew.capabilities?.includes("images"));
  assert.equal(list.default.anthropic, "claude-brand-new-1");
  // The ChatGPT plan signs in in the browser.
  assert.deepEqual(list.all[1]!.capabilities, ["oauth"]);
});

it("lists an OpenAI-compatible server's models from its credential and its /models", () => {
  const list = providerList({
    catalog,
    credentials: [credential("openai-compatible", "local", ["qwen3:4b"])],
    compatibleModels: { local: ["llama-4", "qwen3:4b"] },
  });
  const compatible = list.all.find(
    (provider) => provider.id === "openai-compatible",
  )!;
  assert.deepEqual(Object.keys(compatible.models), ["qwen3:4b", "llama-4"]);
  assert.deepEqual(list.credentials[0]!.modelIds, ["qwen3:4b", "llama-4"]);
});

it("offers no reasoning choice a model does not take", () => {
  assert.deepEqual(
    reasoningChoices(
      model("plain", {
        reasoning: { supported: false, efforts: [], can_disable: false },
      }),
    ),
    [],
  );
  assert.deepEqual(
    reasoningChoices(
      model("toggle", {
        reasoning: {
          supported: true,
          efforts: ["low", "high"],
          can_disable: true,
        },
      }),
    ),
    ["none", "low", "high"],
  );
  // Reasons, but the catalog does not say how: the common three, sent as asked.
  assert.deepEqual(
    reasoningChoices(
      model("unknown", {
        reasoning: { supported: true, efforts: [], can_disable: false },
      }),
    ),
    ["low", "medium", "high"],
  );
});
