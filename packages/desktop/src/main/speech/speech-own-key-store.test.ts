import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SpeechOwnKeyStore,
  type SpeechKeyStorage,
} from "./speech-own-key-store.ts";

const key = `sk-or-v1-${"0a1b2c3d".repeat(8)}`;

function keychain(
  options: { available?: boolean; backend?: string } = {},
): SpeechKeyStorage {
  const seal = (value: string) => `sealed:${[...value].reverse().join("")}`;
  return {
    isAsyncEncryptionAvailable: async () => options.available ?? true,
    encryptStringAsync: async (value) => Buffer.from(seal(value)),
    decryptStringAsync: async (value) => ({
      result: [...value.toString().replace(/^sealed:/, "")].reverse().join(""),
    }),
    getSelectedStorageBackend: options.backend
      ? () => options.backend!
      : undefined,
  };
}

const scratch = () => mkdtemp(join(tmpdir(), "blame-speech-key-"));

test("keeps the key encrypted and tells the app only its last four characters", async () => {
  const directory = await scratch();
  const store = new SpeechOwnKeyStore(directory, keychain());
  const saved = await store.save({ key, model: "openai/whisper-large-v3" });

  assert.deepEqual(saved, {
    ok: true,
    status: {
      configured: true,
      defaultModel: "openai/gpt-transcribe",
      lastFour: "2c3d",
      model: "openai/whisper-large-v3",
      storageAvailable: true,
    },
  });
  for (const name of await readdir(directory)) {
    assert.ok(
      !(await readFile(join(directory, name), "utf8")).includes(key),
      name,
    );
  }
  assert.deepEqual(await store.credentials(), {
    key,
    model: "openai/whisper-large-v3",
  });
  // A new process reads the same state back.
  assert.equal(
    (await new SpeechOwnKeyStore(directory, keychain()).status()).configured,
    true,
  );
});

test("uses the default model until one is chosen, and again once it is emptied", async () => {
  const store = new SpeechOwnKeyStore(await scratch(), keychain());
  await store.save({ key });
  assert.equal((await store.credentials())?.model, "openai/gpt-transcribe");
  await store.save({ model: "openai/whisper-1" });
  assert.equal((await store.credentials())?.model, "openai/whisper-1");
  await store.save({ model: "" });
  assert.equal((await store.credentials())?.model, "openai/gpt-transcribe");
});

test("removes the key and keeps the model choice", async () => {
  const directory = await scratch();
  const store = new SpeechOwnKeyStore(directory, keychain());
  await store.save({ key, model: "openai/whisper-1" });
  const removed = await store.remove();

  assert.equal(removed.configured, false);
  assert.equal(removed.lastFour, undefined);
  assert.equal(removed.model, "openai/whisper-1");
  assert.equal(await store.credentials(), undefined);
  assert.ok(!(await readdir(directory)).includes("openrouter-key.bin"));
});

test("refuses to store a key without a system keychain", async () => {
  for (const storage of [
    keychain({ available: false }),
    keychain({ backend: "basic_text" }),
  ]) {
    const directory = await scratch();
    const store = new SpeechOwnKeyStore(directory, storage);
    const result = await store.save({ key });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "keychain-unavailable");
    assert.deepEqual(await readdir(directory), []);
    assert.equal((await store.status()).storageAvailable, false);
  }
});

test("accepts a real keyring backend on Linux", async () => {
  const store = new SpeechOwnKeyStore(
    await scratch(),
    keychain({ backend: "gnome_libsecret" }),
  );
  assert.equal((await store.save({ key })).ok, true);
});

test("refuses what is not a key or a model id, and writes nothing", async () => {
  const directory = await scratch();
  const store = new SpeechOwnKeyStore(directory, keychain());
  const badKey = await store.save({ key: "sk-proj-not-openrouter-0123456789" });
  const badModel = await store.save({ key, model: "not a model" });

  assert.equal(badKey.ok, false);
  assert.equal(badModel.ok, false);
  assert.deepEqual(await readdir(directory).catch(() => []), []);
});

test("asks for the key again when the keychain cannot open the file", async () => {
  const directory = await scratch();
  await new SpeechOwnKeyStore(directory, keychain()).save({ key });
  const broken: SpeechKeyStorage = {
    ...keychain(),
    decryptStringAsync: async () => {
      throw new Error("keychain changed");
    },
  };
  assert.equal(
    await new SpeechOwnKeyStore(directory, broken).credentials(),
    undefined,
  );
});
