import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PreviewVariablesStore,
  type SecretStorage,
} from "./variables-store.ts";

// Stands in for the keychain: reversible, but never the plain value.
function fakeKeychain(available = true): SecretStorage {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) =>
      Buffer.from(`sealed:${Buffer.from(value).toString("hex")}`),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(
        value.toString().replace(/^sealed:/, ""),
        "hex",
      ).toString(),
    }),
  };
}

async function storeFile(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "blame-preview-variables-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "preview-variables.json");
}

test("keeps project and story variables encrypted, by service", async (t) => {
  const file = await storeFile(t);
  const store = new PreviewVariablesStore(file, fakeKeychain());
  await store.set("project", "/projects/shop", {
    key: "STRIPE_SECRET_KEY",
    value: "sk_test_project",
  });
  await store.set("project", "/projects/shop", {
    key: "STRIPE_SECRET_KEY",
    value: "sk_test_api",
    serviceId: "api",
  });
  await store.set("story", "/worktrees/story-1", {
    key: "FEATURE_FLAG",
    value: "on",
  });
  assert.deepEqual(await store.variables("project", "/projects/shop"), [
    { key: "STRIPE_SECRET_KEY", value: "sk_test_project" },
    { key: "STRIPE_SECRET_KEY", serviceId: "api", value: "sk_test_api" },
  ]);
  assert.deepEqual(await store.variables("story", "/worktrees/story-1"), [
    { key: "FEATURE_FLAG", value: "on" },
  ]);
  assert.deepEqual(await store.variables("story", "/worktrees/other"), []);
  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /sk_test|"on"/);
  assert.match(raw, /STRIPE_SECRET_KEY/);

  await store.set("project", "/projects/shop", {
    key: "STRIPE_SECRET_KEY",
    serviceId: "api",
  });
  assert.deepEqual(await store.variables("project", "/projects/shop"), [
    { key: "STRIPE_SECRET_KEY", value: "sk_test_project" },
  ]);
});

test("records the variables an agent asks for until someone sets them", async (t) => {
  const store = new PreviewVariablesStore(await storeFile(t), fakeKeychain());
  await store.request("/worktrees/story-1", {
    key: "STRIPE_SECRET_KEY",
    reason: "Checkout calls Stripe.",
  });
  await store.request("/worktrees/story-1", {
    key: "STRIPE_SECRET_KEY",
    reason: "Checkout calls Stripe's API.",
    serviceId: "api",
  });
  const requests = await store.requests("/worktrees/story-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.reason, "Checkout calls Stripe's API.");
  await store.set("story", "/worktrees/story-1", {
    key: "STRIPE_SECRET_KEY",
    value: "sk_test_1",
  });
  assert.deepEqual(await store.requests("/worktrees/story-1"), []);
});

test("refuses to store a value without the keychain, and bad names", async (t) => {
  const store = new PreviewVariablesStore(
    await storeFile(t),
    fakeKeychain(false),
  );
  await assert.rejects(
    store.set("project", "/p", { key: "TOKEN", value: "x" }),
    /system keychain is unavailable/,
  );
  await assert.rejects(
    store.set("project", "/p", { key: "BAD KEY", value: "x" }),
    /not a valid variable name/,
  );
});
