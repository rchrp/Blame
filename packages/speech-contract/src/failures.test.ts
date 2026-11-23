import assert from "node:assert/strict";
import test from "node:test";

import {
  openRouterErrorMessage,
  openRouterSpeechFailure,
  speechFailureNeedsSettings,
} from "./index.js";

test("maps OpenRouter's statuses to what the person can do about them", () => {
  const code = (status: number, message?: string) =>
    openRouterSpeechFailure({ message, status }).code;
  assert.equal(code(401), "invalid-key");
  assert.equal(code(402), "no-credits");
  assert.equal(code(403), "forbidden");
  assert.equal(code(404), "model-unavailable");
  assert.equal(
    code(400, "foo/bar is not a valid model ID"),
    "model-unavailable",
  );
  assert.equal(code(400, "Invalid audio data"), "invalid-audio");
  assert.equal(code(413), "too-large");
  assert.equal(code(429), "rate-limited");
  assert.equal(code(504), "timeout");
  assert.equal(code(502), "unavailable");
  assert.equal(code(418), "unavailable");
});

test("sends the person to Settings only for what Settings fixes", () => {
  for (const code of [
    "invalid-key",
    "no-credits",
    "model-unavailable",
    "forbidden",
    "not-configured",
  ] as const) {
    assert.equal(speechFailureNeedsSettings(code), true, code);
  }
  for (const code of [
    "rate-limited",
    "offline",
    "timeout",
    "unavailable",
    "too-large",
    "invalid-audio",
  ] as const) {
    assert.equal(speechFailureNeedsSettings(code), false, code);
  }
});

test("never puts the upstream message in what the person reads", () => {
  const failure = openRouterSpeechFailure({
    message: "key sk-or-v1-abcdef rejected",
    status: 401,
  });
  assert.equal(failure.message.includes("sk-or"), false);
});

test("reads an error message in either body shape", () => {
  assert.equal(openRouterErrorMessage({ error: { message: "nope" } }), "nope");
  assert.equal(openRouterErrorMessage({ error: "plain" }), "plain");
  assert.equal(openRouterErrorMessage(null), undefined);
  assert.equal(openRouterErrorMessage({ error: { code: 1 } }), undefined);
});
