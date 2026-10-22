import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentScreenshotStore,
  agentScreenshotId,
  isAgentScreenshotId,
} from "./agent-screenshot-store.ts";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function input(data = png, overrides: Record<string, unknown> = {}) {
  return {
    colorScheme: "dark" as const,
    data,
    height: 900,
    mimeType: "image/png",
    pageUrl: "http://127.0.0.1:5173/settings",
    runId: "run-1",
    scope: "story:42",
    sessionId: "session-1",
    toolCallId: "call-1",
    viewport: { height: 900, width: 1440 },
    width: 1440,
    ...overrides,
  };
}

async function withStore(
  run: (store: AgentScreenshotStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "blame-screenshots-"));
  try {
    await run(new AgentScreenshotStore(root), root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("stores a capture by its SHA-256 and reads it back", () =>
  withStore(async (store) => {
    const saved = await store.save(input());
    assert.equal(saved.id, agentScreenshotId(png));
    assert.equal(saved.byteLength, png.byteLength);
    const read = await store.read(saved.id);
    assert.deepEqual(read?.data, png);
    assert.equal(read?.metadata.pageUrl, "http://127.0.0.1:5173/settings");
    assert.equal(read?.metadata.scope, "story:42");
  }));

test("the same content is stored once", () =>
  withStore(async (store, root) => {
    const first = await store.save(input());
    const second = await store.save(
      input(png, { runId: "run-2", toolCallId: "call-2" }),
    );
    assert.equal(first.id, second.id);
    const [directory] = await readdir(root);
    const files = await readdir(join(root, directory));
    assert.deepEqual(files.sort(), [`${first.id}.json`, `${first.id}.png`]);
    assert.equal((await store.metadata(first.id))?.runId, "run-2");
  }));

test("rejects malformed ids and unknown types", () =>
  withStore(async (store) => {
    assert.equal(isAgentScreenshotId("A".repeat(64)), false);
    assert.equal(isAgentScreenshotId("a".repeat(63)), false);
    assert.equal(isAgentScreenshotId("../../etc/passwd"), false);
    await assert.rejects(store.read("../secret"), /Invalid screenshot id/);
    assert.equal(await store.read("b".repeat(64)), undefined);
    await assert.rejects(
      store.save(input(png, { mimeType: "text/html" })),
      /Unsupported screenshot type/,
    );
  }));

test("lists by run and cleans up by scope or session", () =>
  withStore(async (store) => {
    const other = Buffer.concat([png, Buffer.from([1])]);
    const chat = Buffer.concat([png, Buffer.from([2])]);
    await store.save(input());
    await store.save(input(other, { runId: "run-2" }));
    await store.save(
      input(chat, { scope: "runner:project:web", sessionId: "chat-session" }),
    );
    assert.equal((await store.list({ runId: "run-1" })).length, 2);
    assert.equal((await store.list({ runId: "run-2" })).length, 1);
    assert.equal((await store.list({ scope: "story:42" })).length, 2);

    assert.equal(await store.deleteSessions(["chat-session"]), 1);
    assert.equal(await store.read(agentScreenshotId(chat)), undefined);
    await store.deleteScope("story:42");
    assert.deepEqual(await store.list({}), []);
  }));
