import assert from "node:assert/strict";
import { test } from "node:test";
import { vmCredential } from "./host.js";

const vm = { hostAlias: "host.lima.internal" };

test("a local endpoint points at this computer from the VM", () => {
  for (const base of [
    "http://127.0.0.1:11434/v1",
    "http://localhost:8080",
    "http://mock.localhost:50283",
  ])
    assert.equal(
      new URL(
        (
          vmCredential({ type: "api_key", key: "k", base_url: base }, vm) as {
            base_url: string;
          }
        ).base_url,
      ).hostname,
      "host.lima.internal",
    );
});

test("a remote endpoint and a credential without one are kept", () => {
  const remote = {
    type: "api_key" as const,
    key: "k",
    base_url: "https://api.example.com/v1",
  };
  assert.deepEqual(vmCredential(remote, vm), remote);
  assert.deepEqual(vmCredential({ type: "missing" }, vm), { type: "missing" });
  assert.deepEqual(
    vmCredential(
      { type: "api_key", key: "k", base_url: "http://127.0.0.1:1" },
      {},
    ),
    { type: "api_key", key: "k", base_url: "http://127.0.0.1:1" },
  );
});
