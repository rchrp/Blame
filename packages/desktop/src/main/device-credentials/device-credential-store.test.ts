import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactLogData } from "../desktop-log-redaction.ts";
import {
  DeviceCredentialStore,
  type DeviceKeyStorage,
} from "./device-credential-store.ts";
import {
  deviceSecrets,
  rememberDeviceSecret,
} from "./device-secret-redaction.ts";

function keychain(available = true, backend?: string): DeviceKeyStorage {
  const seal = (value: string) => `sealed:${[...value].reverse().join("")}`;
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from(seal(value)),
    decryptStringAsync: async (value) => ({
      result: [...value.toString().replace(/^sealed:/, "")].reverse().join(""),
    }),
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  };
}

async function store(storage = keychain()) {
  const directory = await mkdtemp(join(tmpdir(), "blame-device-credentials-"));
  return { directory, store: new DeviceCredentialStore(directory, storage) };
}

const key = "sk-fake-device-key-abcd1234";

test("keeps a key encrypted, and tells the UI only its last four characters", async () => {
  const { directory, store: credentials } = await store();
  const saved = await credentials.save({
    providerId: "openrouter",
    apiKey: key,
  });
  assert.equal(saved.storage, "device");
  assert.equal(saved.lastFour, "1234");
  assert.equal(saved.label, "default");
  // Nothing on disk holds the key in clear.
  for (const name of await readdir(directory)) {
    assert.ok(
      !(await readFile(join(directory, name), "utf8")).includes(key),
      `${name} must not hold the key`,
    );
  }
  // And the listing the UI reads has no secret.
  assert.doesNotMatch(JSON.stringify(await credentials.list()), /fake-device/);
});

test("hands the engine the key, the address and the models", async () => {
  const { store: credentials } = await store();
  await credentials.save({
    providerId: "openai-compatible",
    label: "lab",
    apiKey: key,
    baseUrl: "http://llm.localhost:8080/v1",
    modelIds: ["llama-4"],
  });
  const resolved = await credentials.resolve({
    providerId: "openai-compatible",
    label: "lab",
  });
  assert.equal(resolved?.apiKey, key);
  assert.equal(resolved?.baseUrl, "http://llm.localhost:8080/v1");
  assert.deepEqual(resolved?.modelIds, ["llama-4"]);
  assert.equal(
    await credentials.resolve({ providerId: "openai-compatible" }),
    null,
    "another label is another credential",
  );
});

test("a credential survives a restart of the app", async () => {
  const { directory, store: first } = await store();
  await first.save({ providerId: "openrouter", apiKey: key });
  const second = new DeviceCredentialStore(directory, keychain());
  assert.equal(
    (await second.resolve({ providerId: "openrouter" }))?.apiKey,
    key,
  );
});

test("saving again replaces the credential of that provider and label", async () => {
  const { store: credentials } = await store();
  const first = await credentials.save({
    providerId: "openrouter",
    apiKey: key,
  });
  const second = await credentials.save({
    providerId: "openrouter",
    apiKey: "sk-fake-other-key-9999",
  });
  assert.equal(second.id, first.id);
  assert.equal((await credentials.list()).length, 1);
  assert.equal((await credentials.list())[0].lastFour, "9999");
});

test("keeps and refreshes a ChatGPT sign-in", async () => {
  const { store: credentials } = await store();
  const oauth = {
    access: "fake-access-token-1",
    refresh: "fake-refresh-token-1",
    expires: 2_000_000_000_000,
    accountId: "acct",
  };
  await credentials.save({
    providerId: "chatgpt",
    apiKey: oauth.access,
    oauthCredentials: oauth,
  });
  await credentials.save({
    providerId: "chatgpt",
    apiKey: "fake-access-token-2",
    oauthCredentials: { ...oauth, access: "fake-access-token-2" },
  });
  const resolved = await credentials.resolve({ providerId: "chatgpt" });
  assert.equal(resolved?.authMethod, "oauth");
  assert.equal(resolved?.oauthCredentials?.access, "fake-access-token-2");
  assert.equal(resolved?.oauthCredentials?.refresh, "fake-refresh-token-1");
  const [summary] = await credentials.list();
  assert.equal(summary.accountId, "acct");
  assert.equal(summary.lastFour, undefined, "a sign-in shows no key");
});

test("removes the credential and its secret file", async () => {
  const { directory, store: credentials } = await store();
  const saved = await credentials.save({
    providerId: "openrouter",
    apiKey: key,
  });
  await credentials.remove(saved.id);
  assert.deepEqual(await credentials.list(), []);
  assert.equal(await credentials.resolve({ providerId: "openrouter" }), null);
  assert.deepEqual(
    (await readdir(directory)).filter((n) => n.endsWith(".bin")),
    [],
  );
});

test("refuses to keep a key without the system keychain", async () => {
  for (const storage of [keychain(false), keychain(true, "basic_text")]) {
    const { directory, store: credentials } = await store(storage);
    assert.equal(await credentials.available(), false);
    await assert.rejects(
      credentials.save({ providerId: "openrouter", apiKey: key }),
      /keychain/,
    );
    assert.deepEqual(await readdir(directory), []);
  }
});

test("a key the keychain can no longer open is missing, not an error", async () => {
  const { directory, store: first } = await store();
  await first.save({ providerId: "openrouter", apiKey: key });
  const broken: DeviceKeyStorage = {
    ...keychain(),
    decryptStringAsync: async () => {
      throw new Error("keychain changed");
    },
  };
  const second = new DeviceCredentialStore(directory, broken);
  assert.equal(await second.resolve({ providerId: "openrouter" }), null);
  assert.equal((await second.list()).length, 1);
});

test("concurrent saves do not lose each other", async () => {
  const { store: credentials } = await store();
  await Promise.all(
    ["a", "b", "c", "d"].map((label) =>
      credentials.save({
        providerId: "openrouter",
        label,
        apiKey: `${key}-${label}`,
      }),
    ),
  );
  assert.equal((await credentials.list()).length, 4);
});

test("a key the app has handled never appears in a log line", () => {
  rememberDeviceSecret(key);
  const [line] = redactLogData([`calling with ${key} now`], deviceSecrets());
  assert.ok(!String(line).includes(key));
});
