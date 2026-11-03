import assert from "node:assert/strict";
import test from "node:test";
import { parsePreviewEnvironmentSecrets } from "./environment-secrets.js";

test("accepts resolved variables and env files, refuses what could escape", () => {
  assert.deepEqual(
    parsePreviewEnvironmentSecrets({
      variables: {
        api: { STRIPE_SECRET_KEY: "sk_test_1" },
        "setup-migrate": {},
      },
      files: [{ path: "packages/api/.env", content: "A=1\n" }],
    }),
    {
      variables: {
        api: { STRIPE_SECRET_KEY: "sk_test_1" },
        "setup-migrate": {},
      },
      files: [{ path: "packages/api/.env", content: "A=1\n" }],
    },
  );
  for (const bad of [
    { files: [{ path: "../etc/passwd", content: "" }] },
    { files: [{ path: "/etc/passwd", content: "" }] },
    { files: [{ path: ".git/config", content: "" }] },
    { variables: { api: { "BAD KEY": "x" } } },
    { variables: { api: { KEY: 1 } } },
    { variables: { "../api": {} } },
    [],
  ])
    assert.throws(
      () => parsePreviewEnvironmentSecrets(bad),
      JSON.stringify(bad),
    );
});
