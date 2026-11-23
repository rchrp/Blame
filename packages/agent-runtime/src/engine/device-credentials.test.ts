import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, it } from "node:test";
import type { ModelCatalog } from "@blame/engine-client";
import type {
  DeviceCredential,
  DeviceCredentialInput,
  ProviderCredentialSummary,
} from "../types.js";
import { CredentialResolver } from "./credentials.js";
import { EngineProviders, type DeviceCredentials } from "./providers.js";

type Seen = { method: string; url: string; body: unknown };

/** An API that records every request; `down()` makes it unreachable. */
async function fakeApi() {
  const seen: Seen[] = [];
  const accountKeys = new Map<string, DeviceCredential>();
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const url = request.url ?? "";
    seen.push({ method: request.method ?? "", url, body });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.endsWith("/providers/credentials") && request.method === "GET")
      return json({
        data: [...accountKeys.values()].map((entry) =>
          summary(entry.providerId, entry.label, entry.id),
        ),
      });
    if (url.endsWith("/providers/credentials/resolve")) {
      const entry = accountKeys.get(
        `${(body as { providerId: string }).providerId}/${(body as { label?: string }).label ?? "default"}`,
      );
      return entry ? json({ data: entry }) : json({ error: "none" }, 404);
    }
    if (
      url.endsWith("/providers/credentials") ||
      url.endsWith("/providers/credentials/oauth")
    ) {
      const input = body as {
        providerId: string;
        label?: string;
        apiKey: string;
      };
      const label = input.label ?? "default";
      accountKeys.set(`${input.providerId}/${label}`, {
        id: `cloud-${input.providerId}-${label}`,
        providerId: input.providerId,
        label,
        authMethod: "api-key",
        apiKey: input.apiKey,
        baseUrl: null,
      });
      return json({
        data: summary(
          input.providerId,
          label,
          `cloud-${input.providerId}-${label}`,
        ),
      });
    }
    if (request.method === "DELETE") {
      for (const [key, entry] of accountKeys)
        if (url.endsWith(`/${entry.id}`)) accountKeys.delete(key);
      return json({});
    }
    if (url.endsWith("/providers/recommendations"))
      return json({ error: "no ranking" }, 503);
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
    token: "t",
  };
  after(() => server.close());
  return {
    seen,
    accountKeys,
    connection,
    down: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function summary(providerId: string, label: string, id: string) {
  return {
    id,
    userId: "user",
    providerId,
    label,
    baseUrl: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: null,
  };
}

async function read(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

/** The desktop's keychain store, in memory. */
function fakeDevice(available = true) {
  const stored = new Map<string, DeviceCredential>();
  const saves: DeviceCredentialInput[] = [];
  const device: DeviceCredentials = {
    available: async () => available,
    list: async (): Promise<ProviderCredentialSummary[]> =>
      [...stored.values()].map((entry) => ({
        ...summary(entry.providerId, entry.label, entry.id),
        baseUrl: entry.baseUrl,
        storage: "device" as const,
        lastFour: entry.apiKey.slice(-4),
      })),
    resolve: async ({ providerId, label }) =>
      stored.get(`${providerId}/${label ?? "default"}`) ?? null,
    save: async (input) => {
      saves.push(input);
      const label = input.label ?? "default";
      const entry: DeviceCredential = {
        id: `device-${input.providerId}-${label}`,
        providerId: input.providerId,
        label,
        authMethod: input.oauthCredentials ? "oauth" : "api-key",
        apiKey: input.apiKey,
        baseUrl: input.baseUrl ?? null,
        oauthCredentials: input.oauthCredentials ?? null,
      };
      stored.set(`${input.providerId}/${label}`, entry);
      return {
        ...summary(input.providerId, label, entry.id),
        storage: "device",
      };
    },
    remove: async (id) => {
      for (const [key, entry] of stored)
        if (entry.id === id) stored.delete(key);
    },
  };
  return { device, stored, saves };
}

const catalog: ModelCatalog = {
  source: "models_dev",
  fetched_at_ms: 1,
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      auth: "api_key",
      needs_base_url: false,
      sources: ["openrouter"],
      models: [
        {
          id: "some/model",
          name: "some/model",
          images: false,
          pdf: false,
          reasoning: { supported: false, efforts: [], can_disable: false },
          price: { input: 1_000_000, output: 2_000_000 },
        },
      ],
    },
  ],
};

function providersFor(
  api: Awaited<ReturnType<typeof fakeApi>>,
  device?: DeviceCredentials,
  connection = true,
) {
  const services = {
    connection: () => (connection ? api.connection : undefined),
    ...(device ? { device } : {}),
  };
  return {
    resolver: new CredentialResolver(services, "blame-engine"),
    providers: new EngineProviders({
      ...services,
      catalog: async () => catalog,
      credentials: new CredentialResolver(services, "blame-engine"),
      engineBinary: "blame-engine",
    }),
  };
}

const params = (provider: string) => ({
  session: "s",
  provider,
  attempt: 0,
});

it("a key kept on this device answers the engine without touching the API", async () => {
  const api = await fakeApi();
  const { device } = fakeDevice();
  await device.save({ providerId: "openrouter", apiKey: "fake-device-key" });
  const { resolver } = providersFor(api, device);
  const credential = await resolver.resolve(params("openrouter") as never);
  assert.deepEqual(credential, { type: "api_key", key: "fake-device-key" });
  assert.deepEqual(api.seen, []);
});

it("a key kept on this device still answers when the API is unreachable or absent", async () => {
  const api = await fakeApi();
  const { device } = fakeDevice();
  await device.save({
    providerId: "openrouter",
    apiKey: "fake-device-key",
    baseUrl: "https://openrouter.example/v1",
  });
  await api.down();
  const withApiDown = providersFor(api, device).resolver;
  assert.deepEqual(await withApiDown.resolve(params("openrouter") as never), {
    type: "api_key",
    key: "fake-device-key",
    base_url: "https://openrouter.example/v1",
  });
  const withoutApi = providersFor(api, device, false).resolver;
  assert.equal(
    (await withoutApi.resolve(params("openrouter") as never)).type,
    "api_key",
  );
  // What the device does not hold is missing, not an error.
  assert.deepEqual(await withApiDown.resolve(params("anthropic") as never), {
    type: "missing",
  });
});

it("the provider list shows both places and survives the API being down", async () => {
  const api = await fakeApi();
  const { device } = fakeDevice();
  await device.save({
    providerId: "openrouter",
    apiKey: "fake-device-key-1234",
  });
  const { providers } = providersFor(api, device);
  api.accountKeys.set("anthropic/default", {
    id: "cloud-anthropic",
    providerId: "anthropic",
    label: "default",
    authMethod: "api-key",
    apiKey: "fake-cloud-key",
    baseUrl: null,
  });
  const both = await providers.list(false);
  const byProvider = Object.fromEntries(
    both.credentials.map((credential) => [credential.providerId, credential]),
  );
  assert.equal(byProvider.anthropic.storage, "account");
  assert.equal(byProvider.openrouter.storage, "device");
  assert.equal(byProvider.openrouter.lastFour, "1234");
  assert.ok(both.connected.includes("openrouter"));
  // The secret never appears in what the UI receives.
  assert.doesNotMatch(JSON.stringify(both), /fake-device-key/);

  await api.down();
  const offline = await providers.list(false);
  assert.deepEqual(
    offline.credentials.map((credential) => credential.providerId),
    ["openrouter"],
  );
  assert.ok(offline.connected.includes("openrouter"));
});

it("without a device credential an unreachable API is still an error", async () => {
  const api = await fakeApi();
  const { device } = fakeDevice();
  await api.down();
  await assert.rejects(providersFor(api, device).providers.list(false));
});

it("saving to this device sends nothing to the API", async () => {
  const api = await fakeApi();
  const { device, stored } = fakeDevice();
  const { providers } = providersFor(api, device);
  const saved = await providers.saveCredential({
    providerId: "openrouter",
    apiKey: "fake-device-key",
    storage: "device",
  });
  assert.equal(saved.storage, "device");
  assert.equal(stored.size, 1);
  assert.deepEqual(api.seen, []);
});

it("refuses to keep a key on this device without a keychain", async () => {
  const api = await fakeApi();
  const { providers } = providersFor(api, undefined);
  await assert.rejects(
    providers.saveCredential({
      providerId: "openrouter",
      apiKey: "fake-device-key",
      storage: "device",
    }),
    /keychain/,
  );
  assert.deepEqual(await providers.credentialStorage(), { device: false });
  assert.deepEqual(api.seen, []);
});

it("moves a key to this device and back, never losing it", async () => {
  const api = await fakeApi();
  const { device, stored } = fakeDevice();
  const { providers } = providersFor(api, device);
  await providers.saveCredential({
    providerId: "openrouter",
    apiKey: "fake-moving-key",
  });
  const cloudId = "cloud-openrouter-default";
  const toDevice = await providers.moveCredential({
    id: cloudId,
    providerId: "openrouter",
    label: "default",
    to: "device",
  });
  assert.equal(toDevice.storage, "device");
  assert.equal(stored.get("openrouter/default")?.apiKey, "fake-moving-key");
  assert.equal(api.accountKeys.size, 0, "the account's copy is gone");

  const back = await providers.moveCredential({
    id: toDevice.id,
    providerId: "openrouter",
    label: "default",
    to: "account",
  });
  assert.equal(back.storage, "account");
  assert.equal(stored.size, 0);
  assert.equal(
    api.accountKeys.get("openrouter/default")?.apiKey,
    "fake-moving-key",
  );
});

it("a failed move leaves the credential where it was", async () => {
  const api = await fakeApi();
  const { device, stored } = fakeDevice();
  const { providers } = providersFor(api, device);
  await device.save({ providerId: "openrouter", apiKey: "fake-device-key" });
  await api.down();
  await assert.rejects(
    providers.moveCredential({
      id: "device-openrouter-default",
      providerId: "openrouter",
      label: "default",
      to: "account",
    }),
  );
  assert.equal(stored.size, 1);
});

it("a ChatGPT sign-in kept on this device is refreshed and saved back to it, not to the API", async () => {
  const api = await fakeApi();
  const { device, saves } = fakeDevice();
  await device.save({
    providerId: "chatgpt",
    apiKey: "old-access",
    oauthCredentials: {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1_000,
      accountId: "acct",
    },
  });
  saves.length = 0;
  const resolver = new CredentialResolver(
    {
      connection: () => api.connection,
      device,
      refreshChatGpt: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_at_s: Math.floor(Date.now() / 1000) + 3600,
      }),
    },
    "blame-engine",
  );
  const credential = await resolver.resolve(params("chatgpt") as never);
  assert.deepEqual(credential, {
    type: "bearer",
    token: "new-access",
    account: "acct",
  });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].oauthCredentials?.refresh, "new-refresh");
  assert.deepEqual(api.seen, []);
});

it("refuses a move onto a connection of the same name and keeps both keys", async () => {
  const api = await fakeApi();
  const { device, stored } = fakeDevice();
  const { providers } = providersFor(api, device);
  await providers.saveCredential({
    providerId: "openrouter",
    label: "Work",
    apiKey: "fake-account-key",
  });
  await device.save({
    providerId: "openrouter",
    label: "Work",
    apiKey: "fake-device-key",
  });
  await assert.rejects(
    providers.moveCredential({
      id: "device-openrouter-Work",
      providerId: "openrouter",
      label: "Work",
      to: "account",
    }),
    /already exists in your Blame account/,
  );
  await assert.rejects(
    providers.moveCredential({
      id: "cloud-openrouter-Work",
      providerId: "openrouter",
      label: "Work",
      to: "device",
    }),
    /already exists on this device/,
  );
  assert.equal(stored.get("openrouter/Work")?.apiKey, "fake-device-key");
  assert.equal(
    api.accountKeys.get("openrouter/Work")?.apiKey,
    "fake-account-key",
  );
});
