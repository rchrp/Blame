import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import type { ModelCatalog } from "@blame/engine-client";
import { CredentialResolver } from "./credentials.js";
import { EngineProviders } from "./providers.js";

type Seen = { method: string; url: string; body: unknown; auth?: string };

/** The API and an OpenAI-compatible server, on one port. */
async function fakeServers() {
  const seen: Seen[] = [];
  const saved: unknown[] = [];
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const url = request.url ?? "";
    seen.push({
      method: request.method ?? "",
      url,
      body,
      auth: request.headers.authorization,
    });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url === "/api/v1/providers/credentials" && request.method === "GET")
      return json({
        data: [
          summary("anthropic", "default", null),
          summary("openai-compatible", "local", `${base()}/compatible/v1`),
        ],
      });
    if (url === "/api/v1/providers/credentials/resolve")
      return json({
        data: {
          id: "c",
          providerId: "openai-compatible",
          label: "local",
          apiKey: "sk-local",
          baseUrl: null,
        },
      });
    if (url === "/compatible/v1/models")
      return json({
        object: "list",
        data: [{ id: "llama-4" }, { id: "qwen3:4b" }],
      });
    if (url === "/api/v1/providers/recommendations")
      return json({
        data: {
          generatedAt: "2026-11-20T00:00:00.000Z",
          benchmarkBoundary: 0.74,
          all: [
            {
              providerId: "anthropic",
              modelId: "claude-older",
              position: 0.9,
              segment: "benchmarked",
              estimatedCost: 1,
            },
          ],
          byProvider: {
            anthropic: [
              {
                providerId: "anthropic",
                modelId: "claude-older",
                position: 0.9,
                segment: "benchmarked",
                estimatedCost: 1,
              },
            ],
          },
          profile: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            sampleCount: 0,
          },
        },
      });
    if (url === "/api/v1/providers/credentials/oauth") {
      saved.push(body);
      return json({ data: summary("chatgpt", "default", null) });
    }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = () =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  after(() => server.close());
  return { seen, saved, api: { url: `${base()}/api/v1`, token: "t" } };
}

function summary(providerId: string, label: string, baseUrl: string | null) {
  return {
    id: `${providerId}-${label}`,
    userId: "user",
    providerId,
    label,
    baseUrl,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: null,
  };
}

async function read(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
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
      models: ["claude-brand-new-1", "claude-older"].map((id) => ({
        id,
        name: id,
        images: true,
        pdf: true,
        reasoning: { supported: false, efforts: [], can_disable: false },
        price: { input: 3_000_000, output: 15_000_000 },
      })),
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

it("lists the engine's catalog with the credentials, the server's own models and the API's ranking", async () => {
  const { seen, api } = await fakeServers();
  const asked: boolean[] = [];
  const providers = new EngineProviders({
    connection: () => api,
    catalog: async (refresh) => (asked.push(refresh), catalog),
    credentials: new CredentialResolver(
      { connection: () => api },
      "blame-engine",
    ),
    engineBinary: "blame-engine",
  });
  const list = await providers.list(true);
  assert.deepEqual(asked, [true]);
  assert.deepEqual(list.connected, ["anthropic", "openai-compatible"]);
  const compatible = list.all.find(
    (provider) => provider.id === "openai-compatible",
  )!;
  assert.deepEqual(Object.keys(compatible.models), ["llama-4", "qwen3:4b"]);
  // The server's /models was asked with its own key.
  assert.equal(
    seen.find((request) => request.url === "/compatible/v1/models")?.auth,
    "Bearer sk-local",
  );
  // The API ranks what the engine offers; it keeps no catalog.
  const ranking = seen.find((request) =>
    request.url.endsWith("/recommendations"),
  );
  const sent = ranking?.body as {
    models: Array<{
      providerId: string;
      modelId: string;
      cost: { input: number };
    }>;
  };
  assert.ok(
    sent.models.some(
      (model) =>
        model.modelId === "claude-brand-new-1" && model.cost.input === 3,
    ),
  );
  assert.equal(list.default.anthropic, "claude-older", "the ranking's first");
  assert.equal(list.recommendations.all[0]?.modelId, "claude-older");
});

it("signs in to ChatGPT with the engine's sign-in and keeps the tokens in the API", async () => {
  const { saved, api } = await fakeServers();
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-sign-in-"));
  after(() => rm(directory, { recursive: true, force: true }));
  // Stands in for `blame-engine auth chatgpt login`: what to open, then the tokens.
  const binary = join(directory, "blame-engine");
  await writeFile(
    binary,
    `#!/bin/sh
[ "$1 $2 $3" = "auth chatgpt login" ] || exit 2
echo '{"authorize_url":"https://auth.openai.com/oauth/authorize?x=1"}'
echo '{"access_token":"at","refresh_token":"rt","account_id":"acct","expires_at_s":2000000000}'
`,
  );
  await chmod(binary, 0o755);
  const opened: string[] = [];
  const providers = new EngineProviders({
    connection: () => api,
    catalog: async () => catalog,
    credentials: new CredentialResolver({ connection: () => api }, binary),
    engineBinary: binary,
    openExternal: async (url) => void opened.push(url),
  });
  const credential = await providers.signInChatGpt("work");
  assert.equal(credential.providerId, "chatgpt");
  assert.deepEqual(opened, ["https://auth.openai.com/oauth/authorize?x=1"]);
  assert.deepEqual(saved, [
    {
      providerId: "chatgpt",
      label: "work",
      apiKey: "at",
      oauthCredentials: {
        access: "at",
        refresh: "rt",
        expires: 2_000_000_000_000,
        accountId: "acct",
      },
      baseUrl: null,
    },
  ]);

  await writeFile(
    binary,
    "#!/bin/sh\necho 'blame-engine: the sign-in was cancelled' >&2\nexit 1\n",
  );
  await assert.rejects(
    providers.signInChatGpt(),
    /The ChatGPT sign-in failed: the sign-in was cancelled/,
  );
});
