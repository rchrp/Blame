import assert from "node:assert/strict";
import { test } from "node:test";
import { vmCredential, vmProviderCredential } from "./host-helpers.js";

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

test("WSL relays only Claude Code and keeps its session key", async () => {
  const credential = {
    type: "api_key" as const,
    key: "bcc1.session.signature",
    base_url: "http://127.0.0.1:4000/v1",
  };
  const wsl = {
    async claudeCodeSocket(baseUrl: string) {
      assert.equal(baseUrl, credential.base_url);
      return "/tmp/private/bridge.sock";
    },
  };
  assert.deepEqual(await vmProviderCredential("claude-code", credential, wsl), {
    type: "claude_code_socket",
    key: credential.key,
    path: "/tmp/private/bridge.sock",
  });
  assert.deepEqual(
    await vmProviderCredential("openai-compatible", credential, wsl),
    credential,
  );
  assert.deepEqual(await vmProviderCredential("claude-code", credential, vm), {
    ...credential,
    base_url: "http://host.lima.internal:4000/v1",
  });
});
