import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localApiKey, type SecretStorage } from "./local-api-key.ts";

function keychain(available = true): SecretStorage {
  const seal = (value: string) => `sealed:${[...value].reverse().join("")}`;
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from(seal(value)),
    decryptStringAsync: async (value) => ({
      result: [...value.toString().replace(/^sealed:/, "")].reverse().join(""),
    }),
  };
}

test("creates the local API key once and keeps only its encrypted form", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-local-api-"));
  const first = await localApiKey(directory, keychain());
  const second = await localApiKey(directory, keychain());

  assert.equal(second, first);
  assert.ok(first.length >= 32);
  assert.deepEqual(await readdir(directory), ["app-key.bin"]);
  const stored = await readFile(join(directory, "app-key.bin"), "utf8");
  assert.ok(!stored.includes(first));
});

test("refuses to keep the key without the system keychain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-local-api-"));
  await assert.rejects(localApiKey(directory, keychain(false)), /keychain/);
  assert.deepEqual(await readdir(directory), []);
});
