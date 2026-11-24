import assert from "node:assert/strict";
import test from "node:test";
import {
  openRouterBaseUrl,
  testOpenRouterKey,
  transcribeWithOpenRouter,
} from "./openrouter-speech.ts";

const key = `sk-or-v1-${"0a1b2c3d".repeat(8)}`;
const audio = Buffer.from("voice").toString("base64");
const input = {
  data: audio,
  format: "webm",
  key,
  model: "openai/gpt-transcribe",
};

type Call = { init: RequestInit; url: string };

function fakeFetch(
  respond: (call: Call) => Response | Promise<Response> | Error,
  calls: Call[] = [],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const call = { init, url };
    calls.push(call);
    const result = await respond(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

test("sends the request the hosted API sends, with the person's key", async () => {
  const calls: Call[] = [];
  const result = await transcribeWithOpenRouter(input, {
    baseUrl: "https://openrouter.test/api/v1",
    fetcher: fakeFetch(() => json({ text: "  hello there \n" }), calls),
  });

  assert.deepEqual(result, { ok: true, text: "hello there" });
  assert.equal(
    calls[0].url,
    "https://openrouter.test/api/v1/audio/transcriptions",
  );
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    input_audio: { data: audio, format: "webm" },
    model: "openai/gpt-transcribe",
    temperature: 0,
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${key}`);
  assert.equal(headers.get("HTTP-Referer"), "https://blame.dev");
  assert.equal(headers.get("X-OpenRouter-Title"), "Blame");
  assert.ok(calls[0].init.signal);
});

test("requests Azure clean transcription for MAI-Transcribe 2", async () => {
  const calls: Call[] = [];
  const model = "microsoft/mai-transcribe-2";
  const result = await transcribeWithOpenRouter(
    { ...input, format: "wav", model },
    { fetcher: fakeFetch(() => json({ text: "Hello there." }), calls) },
  );

  assert.deepEqual(result, { ok: true, text: "Hello there." });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    input_audio: { data: audio, format: "wav" },
    model,
    temperature: 0,
    provider: {
      options: {
        azure: { enhancedMode: { modelOptions: { transcribeStyle: "clean" } } },
      },
    },
  });
});

test("tells apart what OpenRouter refuses", async () => {
  const failure = async (status: number, body: unknown = {}) => {
    const result = await transcribeWithOpenRouter(input, {
      fetcher: fakeFetch(() => json(body, status)),
    });
    return result.ok ? "ok" : result.code;
  };
  assert.equal(
    await failure(401, { error: { message: "No auth" } }),
    "invalid-key",
  );
  assert.equal(await failure(402), "no-credits");
  assert.equal(await failure(404), "model-unavailable");
  assert.equal(
    await failure(400, { error: { message: "x is not a valid model ID" } }),
    "model-unavailable",
  );
  assert.equal(await failure(429), "rate-limited");
  assert.equal(await failure(502), "unavailable");
});

test("never repeats the key or the upstream message", async () => {
  const result = await transcribeWithOpenRouter(input, {
    fetcher: fakeFetch(() => json({ error: { message: `bad ${key}` } }, 401)),
  });
  assert.equal(JSON.stringify(result).includes("sk-or-"), false);
});

test("reports a network failure as offline and a timeout as such", async () => {
  const offline = await transcribeWithOpenRouter(input, {
    fetcher: fakeFetch(() => new TypeError("fetch failed")),
  });
  const slow = await transcribeWithOpenRouter(input, {
    fetcher: fakeFetch(() =>
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    ),
  });
  assert.equal(!offline.ok && offline.code, "offline");
  assert.equal(!slow.ok && slow.code, "timeout");
});

test("really gives up on a request that never answers", async () => {
  const result = await transcribeWithOpenRouter(input, {
    fetcher: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      })) as typeof fetch,
    timeoutMs: 20,
  });
  assert.equal(!result.ok && result.code, "timeout");
});

test("refuses a recording before any request when it is not valid", async () => {
  let requests = 0;
  const fetcher = fakeFetch(() => {
    requests += 1;
    return json({ text: "x" });
  });
  const code = async (data: string, format: string) => {
    const result = await transcribeWithOpenRouter(
      { ...input, data, format },
      { fetcher },
    );
    return result.ok ? "ok" : result.code;
  };
  assert.equal(await code("", "webm"), "invalid-audio");
  assert.equal(await code("not base64!", "webm"), "invalid-audio");
  assert.equal(await code(audio, "exe"), "invalid-audio");
  assert.equal(
    await code(Buffer.alloc(12_000_001).toString("base64"), "webm"),
    "too-large",
  );
  assert.equal(requests, 0);
});

test("fails on an answer without text", async () => {
  const result = await transcribeWithOpenRouter(input, {
    fetcher: fakeFetch(() => json({ ok: true })),
  });
  assert.equal(!result.ok && result.code, "unavailable");
});

test("tests the key and model without asking for a transcription", async () => {
  const calls: Call[] = [];
  const result = await testOpenRouterKey(input, {
    baseUrl: "https://openrouter.test/api/v1",
    fetcher: fakeFetch(
      ({ url }) =>
        url.endsWith("/key")
          ? json({
              data: {
                label: "sk-or-v1-...",
                limit: null,
                limit_remaining: null,
              },
            })
          : json({
              data: [
                { id: "openai/gpt-transcribe" },
                { id: "openai/whisper-1" },
              ],
            }),
      calls,
    ),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((call) => [call.init.method ?? "GET", call.url]),
    [
      ["GET", "https://openrouter.test/api/v1/key"],
      [
        "GET",
        "https://openrouter.test/api/v1/models?output_modalities=transcription",
      ],
    ],
  );
  assert.equal(
    calls.some((call) => call.url.includes("transcriptions")),
    false,
  );
});

test("the test names a wrong key, an used up key and an unknown model", async () => {
  const run = async (
    respond: (url: string) => Response,
    model = input.model,
  ) => {
    const result = await testOpenRouterKey(
      { ...input, model },
      {
        fetcher: fakeFetch(({ url }) => respond(url)),
      },
    );
    return result.ok ? "ok" : result.code;
  };
  const listed = json({ data: [{ id: "openai/gpt-transcribe" }] });
  assert.equal(
    await run(() => json({ error: { message: "bad" } }, 401)),
    "invalid-key",
  );
  assert.equal(
    await run((url) =>
      url.endsWith("/key") ? json({ data: { limit_remaining: 0 } }) : listed,
    ),
    "no-credits",
  );
  assert.equal(
    await run(
      (url) => (url.endsWith("/key") ? json({ data: {} }) : listed),
      "openai/gpt-5",
    ),
    "model-unavailable",
  );
});

test("the test accepts the model when the list cannot be read", async () => {
  const result = await testOpenRouterKey(input, {
    fetcher: fakeFetch(({ url }) =>
      url.endsWith("/key") ? json({ data: {} }) : json({}, 500),
    ),
  });
  assert.deepEqual(result, { ok: true });
});

test("only a local test server can stand in for OpenRouter", () => {
  const real = "https://openrouter.ai/api/v1";
  assert.equal(openRouterBaseUrl({}), real);
  assert.equal(
    openRouterBaseUrl({
      BLAME_OPENROUTER_BASE_URL: "http://127.0.0.1:4000/api/v1/",
    }),
    "http://127.0.0.1:4000/api/v1",
  );
  assert.equal(
    openRouterBaseUrl({ BLAME_OPENROUTER_BASE_URL: "http://localhost:4000" }),
    "http://localhost:4000",
  );
  assert.equal(
    openRouterBaseUrl({
      BLAME_OPENROUTER_BASE_URL: "https://evil.example/api",
    }),
    real,
  );
  assert.equal(
    openRouterBaseUrl({
      BLAME_OPENROUTER_BASE_URL: "http://localhost.evil.example",
    }),
    real,
  );
  assert.equal(
    openRouterBaseUrl({ BLAME_OPENROUTER_BASE_URL: "not a url" }),
    real,
  );
});
