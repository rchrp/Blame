import assert from "node:assert/strict";
import test from "node:test";

import { contextLimitConfig } from "./context-limit-config.js";

test("passes a chosen context cap to the session's provider config", () => {
  assert.deepEqual(
    contextLimitConfig({
      maxInputTokens: 128_000.6,
      modelId: "gpt-6.1-sol",
      providerId: "openai-codex",
    }),
    {
      providerConfig: {
        providerId: "openai-codex",
        modelId: "gpt-6.1-sol",
        maxInputTokens: 128_000,
      },
    },
  );
});

test("keeps the provider's own limit when no usable cap is set", () => {
  const model = { modelId: "m", providerId: "p" };
  assert.deepEqual(contextLimitConfig(model), {});
  assert.deepEqual(contextLimitConfig({ ...model, maxInputTokens: 0 }), {});
  assert.deepEqual(
    contextLimitConfig({ ...model, maxInputTokens: Number.NaN }),
    {},
  );
});
