import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The handlers run as in the app, against Electron's test stand-in.
const electronStub = pathToFileURL(
  join(import.meta.dirname, "../electron-test-stub.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return { url: electronStub, shortCircuit: true };
    return next(specifier, context);
  },
});

const { ipcHandlers } = await import("../electron-test-stub.ts");
const { registerSpeechIpcHandlers } = await import("./speech-ipc.ts");
const { SpeechOwnKeyStore } = await import("../speech/speech-own-key-store.ts");

const key = `sk-or-v1-${"0a1b2c3d".repeat(8)}`;
const appWindow = { sender: "app" };
const otherWindow = { sender: "other" };
const audio = Buffer.from("voice").toString("base64");

const requests: Array<{
  authorization: string | null;
  body: unknown;
  url: string;
}> = [];
const fetcher = (async (url: string, init: RequestInit) => {
  requests.push({
    authorization: new Headers(init.headers).get("Authorization"),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    url,
  });
  return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
}) as typeof fetch;

const storage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (value: string) => Buffer.from(`sealed:${value}`),
  decryptStringAsync: async (value: Buffer) => ({
    result: value.toString().replace(/^sealed:/, ""),
  }),
};

registerSpeechIpcHandlers({
  isAppWindow: (sender) => (sender as unknown) === "app",
  options: { baseUrl: "https://openrouter.test/api/v1", fetcher },
  store: new SpeechOwnKeyStore(
    await mkdtemp(join(tmpdir(), "blame-speech-ipc-")),
    storage,
  ),
});

const call = async (
  channel: string,
  input?: unknown,
  event: object = appWindow,
) => ipcHandlers.get(channel)!(event, input);

test("only the app's windows may use the key", async () => {
  for (const channel of [
    "speech-key:status",
    "speech-key:save",
    "speech-key:remove",
    "speech-key:test",
    "speech-key:transcribe",
    "speech-key:use-provider-key",
  ]) {
    await assert.rejects(call(channel, {}, otherWindow), /rejected/, channel);
  }
});

test("a dictation without a saved key says so", async () => {
  const result = await call("speech-key:transcribe", {
    data: audio,
    format: "webm",
  });
  assert.deepEqual(result, {
    ok: false,
    code: "not-configured",
    message: "No OpenRouter key is saved on this computer.",
  });
  assert.equal(requests.length, 0);
});

test("saves the key, then transcribes with it from the main process", async () => {
  const saved = await call("speech-key:save", {
    key,
    model: "openai/whisper-1",
  });
  assert.equal(JSON.stringify(saved).includes(key), false);
  assert.equal(
    JSON.stringify(await call("speech-key:status")).includes(key),
    false,
  );

  const result = await call("speech-key:transcribe", {
    data: audio,
    format: "webm",
  });
  assert.deepEqual(result, { ok: true, text: "hello" });
  assert.equal(
    requests[0].url,
    "https://openrouter.test/api/v1/audio/transcriptions",
  );
  assert.equal(requests[0].authorization, `Bearer ${key}`);
  assert.equal(
    (requests[0].body as { model: string }).model,
    "openai/whisper-1",
  );
});

test("reuses the OpenRouter key of Settings → Models without the app seeing it", async () => {
  await call("speech-key:remove");
  const provided = `sk-or-v1-${"f0e1d2c3".repeat(8)}`;
  const original = globalThis.fetch;
  const apiCalls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    apiCalls.push(
      `${init.method} ${url} ${new Headers(init.headers).get("Authorization")}`,
    );
    return new Response(JSON.stringify({ data: { apiKey: provided } }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const result = await call("speech-key:use-provider-key", {
      token: "api-token",
      url: "http://127.0.0.1:3333/api/v1/",
    });
    assert.equal(result && (result as { ok: boolean }).ok, true);
    assert.equal(JSON.stringify(result).includes(provided), false);
    assert.deepEqual(apiCalls, [
      "POST http://127.0.0.1:3333/api/v1/providers/credentials/resolve Bearer api-token",
    ]);
  } finally {
    globalThis.fetch = original;
  }
  requests.length = 0;
  await call("speech-key:transcribe", { data: audio, format: "webm" });
  assert.equal(requests[0].authorization, `Bearer ${provided}`);
});

test("reports a provider key that cannot be found", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as typeof fetch;
  try {
    const result = (await call("speech-key:use-provider-key", {
      url: "http://127.0.0.1:1",
    })) as { ok: boolean; code?: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, "not-configured");
  } finally {
    globalThis.fetch = original;
  }
});
