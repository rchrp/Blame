import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "@cline/llms";
import { splitCoreSessionConfig, type CoreSessionConfig } from "@cline/sdk";
import { appendProductionConfig } from "./production.js";
import {
  clineProviderId,
  knownModelInfo,
  supplementalModelConfig,
} from "./supplemental-model-config.js";

// The app names providers by the engine's ids (`chatgpt`, `openai`); the
// Cline path, until it moves to the engine, gets Cline's own.
function config(): CoreSessionConfig {
  return {
    providerId: "chatgpt",
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

test("engine provider ids reach Cline as Cline's", () => {
  assert.equal(clineProviderId("chatgpt"), "openai-codex");
  assert.equal(clineProviderId("openai"), "openai-native");
  assert.equal(clineProviderId("anthropic"), "anthropic");
  assert.equal(clineProviderId("openai-compatible"), "openai-compatible");
  assert.equal(appendProductionConfig(config()).providerId, "openai-codex");
  const nested = supplementalModelConfig({
    ...config(),
    providerId: "openai",
    providerConfig: { providerId: "openai", modelId: "gpt-5.5" },
  });
  assert.equal(nested.providerId, "openai-native");
  assert.equal(nested.providerConfig?.providerId, "openai-native");
  assert.equal(knownModelInfo("chatgpt", "gpt-6-astra")?.name, "GPT-6 Astra");
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

