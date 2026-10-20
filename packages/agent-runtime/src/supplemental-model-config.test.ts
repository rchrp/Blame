import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandler,
  getProviderCollectionSync,
  registerProvider,
} from "@cline/llms";
import {
  buildDelegatedAgentConfig,
  createDelegatedAgentConfigProvider,
  splitCoreSessionConfig,
  type CoreSessionConfig,
} from "@cline/sdk";
import { appendProductionConfig } from "./production.js";
import {
  loadCatalogModel,
  supplementalModelConfig,
} from "./supplemental-model-config.js";
import { listClineProviders } from "./provider-catalog.js";
import type { SupplementalModel } from "@blame/model-catalog";

function config(): CoreSessionConfig {
  return {
    providerId: "openai-codex",
    modelId: "gpt-6-astra",
    cwd: "/offline-workspace",
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    apiKey: "offline-placeholder",
    baseUrl: "https://offline.invalid",
    reasoningEffort: "high",
  };
}

const fixture: SupplementalModel = {
  providerId: "openai-codex",
  model: {
    id: "future-model",
    name: "Future model",
    contextWindow: 500_000,
    maxInputTokens: 450_000,
    maxTokens: 64_000,
    capabilities: ["images", "tools", "reasoning"],
  },
  source: "https://example.com/models/future-model",
  verifiedAt: "2026-10-20",
};

function future(): CoreSessionConfig {
  return { ...config(), modelId: fixture.model.id };
}

test("official Astra metadata replaces the retired supplemental entry", async () => {
  const providers = await listClineProviders();
  for (const providerId of ["openai-codex", "openai-native"]) {
    const model = providers.find((p) => p.id === providerId)?.models["gpt-6-astra"];
    assert.equal(model?.name, "GPT-6 Astra");
    assert.ok(Object.keys(model?.variants ?? {}).includes("max"));
  }
  assert.equal(appendProductionConfig(config()).knownModels, undefined);
});

test("supplemental metadata survives Cline normalization and remote JSON transport", () => {
  const original = future();
  const local = supplementalModelConfig(original, [fixture]);
  const remote = splitCoreSessionConfig(JSON.parse(JSON.stringify(local))).config;
  assert.equal(original.knownModels, undefined);
  assert.deepEqual(remote.knownModels, JSON.parse(JSON.stringify(local.knownModels)));
  const handler = createHandler({ ...remote, accessToken: "offline-placeholder" });
  assert.equal(handler.getModel().id, fixture.model.id);
  assert.equal(handler.getModel().info.contextWindow, 500_000);
  assert.equal(handler.getModel().info.maxInputTokens, 450_000);
});

test("an official provider entry automatically removes the custom session metadata", () => {
  const official = { id: fixture.model.id, name: "Official", contextWindow: 999_000 };
  const original = getProviderCollectionSync("openai-codex")!;
  registerProvider({ ...original, models: { ...original.models, [official.id]: official } });
  try {
    const input = future();
    assert.equal(supplementalModelConfig(input, [fixture]), input);
  } finally {
    registerProvider(original);
  }
});

test("delegated specialists inherit the supplemental model metadata", () => {
  const configProvider = createDelegatedAgentConfigProvider(supplementalModelConfig(future(), [fixture]));
  const delegated = buildDelegatedAgentConfig({ kind: "subagent", prompt: "Inspect the code", tools: [], configProvider });
  assert.equal(delegated.modelId, fixture.model.id);
  assert.equal(delegated.knownModels?.[fixture.model.id]?.maxInputTokens, 450_000);
});

test("explicit knownModels and provider settings retain their precedence", () => {
  const explicit = { id: fixture.model.id, contextWindow: 100_000 };
  const input = { ...future(), knownModels: { [explicit.id]: explicit } };
  assert.equal(supplementalModelConfig(input, [fixture]).knownModels?.[explicit.id], explicit);
  const nested = {
    ...future(),
    providerConfig: { providerId: "openai-codex", modelId: explicit.id, knownModels: { [explicit.id]: explicit } },
  };
  assert.equal(supplementalModelConfig(nested, [fixture]).providerConfig?.knownModels?.[explicit.id], explicit);
  const unknown = { ...future(), providerId: "unconfigured-provider" };
  assert.equal(supplementalModelConfig(unknown, [fixture]), unknown);
  const existing = { ...future(), modelId: "gpt-5.6-sol" };
  assert.equal(supplementalModelConfig(existing, [fixture]), existing);
});

test("the real Codex handler sends official Astra, images, tools and the selected reasoning", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected network");
  });
  const requests: Record<string, unknown>[] = [];
  const settings = splitCoreSessionConfig(
    JSON.parse(JSON.stringify(appendProductionConfig(config()))),
  ).config;
  const handler = createHandler({
    ...settings,
    accessToken: "offline-placeholder",
    fetch: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(String(url), "https://offline.invalid/responses");
      requests.push(JSON.parse(String(init?.body)));
      return new Response('{"error":{"message":"Offline capture"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    for await (const part of handler.createMessage(
      "Inspect the image.",
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
          ],
        },
      ],
      [
        {
          name: "inspect",
          description: "Inspect a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    )) {
      // The offline endpoint deliberately returns an error after capturing the request.
      assert.ok(part.type === "error" || part.type === "done");
    }
  } catch (error) {
    assert.match(String(error), /Offline capture/);
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-6-astra");
  assert.equal((requests[0].reasoning as { effort: string }).effort, "high");
  assert.match(JSON.stringify(requests[0].input), /input_image/);
  assert.match(JSON.stringify(requests[0].tools), /inspect/);
});

test("catalog metadata reaches sessions for models newer than the bundled SDK", async () => {
  const modelId = "catalog-only-model";
  const info = { id: modelId, name: "Catalog only", contextWindow: 400_000, maxTokens: 64_000 };
  let requests = 0;
  await loadCatalogModel(async () => (requests++, info), "anthropic", modelId);
  await loadCatalogModel(async () => (requests++, info), "anthropic", modelId);
  assert.equal(requests, 1);
  const session = appendProductionConfig({
    ...config(),
    providerId: "anthropic",
    modelId,
  });
  assert.deepEqual(session.knownModels?.[modelId], info);
  const handler = createHandler({ ...session, apiKey: "offline-placeholder" });
  assert.equal(handler.getModel().info.contextWindow, 400_000);
});

test("bundled models and catalog failures never trigger catalog metadata", async () => {
  const [bundled] = Object.keys(getProviderCollectionSync("anthropic")!.models);
  let requests = 0;
  await loadCatalogModel(async () => (requests++, undefined), "anthropic", bundled!);
  assert.equal(requests, 0);
  await loadCatalogModel(async () => {
    throw new Error("API unavailable");
  }, "anthropic", "unreachable-model");
  const session = { ...config(), providerId: "anthropic", modelId: "unreachable-model" };
  assert.equal(supplementalModelConfig(session), session);
});
