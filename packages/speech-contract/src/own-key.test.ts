import assert from "node:assert/strict";
import test from "node:test";

import {
  checkOpenRouterKey,
  checkSpeechModel,
  openRouterKeyLastFour,
} from "./index.js";

const key = `sk-or-v1-${"a1b2c3d4".repeat(8)}`;

test("accepts an OpenRouter key and trims what was pasted around it", () => {
  assert.deepEqual(checkOpenRouterKey(`  ${key}\n`), { ok: true, value: key });
  assert.equal(openRouterKeyLastFour(key), "c3d4");
});

test("refuses what is not an OpenRouter key", () => {
  for (const input of ["", "   ", "sk-proj-abcdefghijklmnopqrstuvwx", "sk-or-", "sk-or-v1-short", `${key} ${key}`, "https://openrouter.ai/keys"]) {
    assert.equal(checkOpenRouterKey(input).ok, false, input);
  }
});

test("takes an empty model as the default one", () => {
  assert.deepEqual(checkSpeechModel("  "), { ok: true, value: undefined });
});

test("accepts model ids as OpenRouter writes them", () => {
  for (const model of [
    "openai/gpt-transcribe",
    "openai/whisper-large-v3-turbo",
    "mistralai/voxtral-small-24b-2507-stt",
    "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    "openai/gpt-4o-mini-transcribe:free",
  ]) {
    assert.deepEqual(checkSpeechModel(` ${model} `), { ok: true, value: model });
  }
});

test("refuses what is not a model id", () => {
  for (const model of ["gpt-transcribe", "openai/", "/gpt", "openai/gpt transcribe", "Openai/gpt", "https://openrouter.ai/openai/gpt-transcribe", "a/b/c d"]) {
    assert.equal(checkSpeechModel(model).ok, false, model);
  }
});
