import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceWriterRegistry } from "./workspace-writer-registry.ts";

test("tracks one local writer across session binding and completion", () => {
  const registry = new WorkspaceWriterRegistry();
  registry.begin("pending", "/work/story");
  assert.equal(registry.hasActiveWriter("/work/story"), true);

  registry.rebind("pending", "session-a");
  assert.equal(registry.workspaceForSession("session-a"), "/work/story");
  assert.equal(registry.hasActiveWriter("/work/story"), true);

  registry.end("session-a");
  assert.equal(registry.hasActiveWriter("/work/story"), false);
  assert.equal(registry.workspaceForSession("session-a"), "/work/story");
});

test("releasing a workspace removes active and resumable session ownership", () => {
  const registry = new WorkspaceWriterRegistry();
  registry.begin("session-a", "/work/story");
  registry.releaseWorkspace("/work/story/.");
  assert.equal(registry.hasActiveWriter("/work/story"), false);
  assert.equal(registry.workspaceForSession("session-a"), undefined);
});

test("lets several writers share the same canonical workspace", () => {
  const registry = new WorkspaceWriterRegistry();
  registry.begin("session-a", "/work/project");
  registry.begin("session-b", "/work/project/../project");

  assert.equal(registry.workspaceForSession("session-b"), "/work/project");
  registry.end("session-a");
  assert.equal(registry.hasActiveWriter("/work/project"), true);
  registry.end("session-b");
  assert.equal(registry.hasActiveWriter("/work/project"), false);
});

test("keeps an active session in one workspace", () => {
  const registry = new WorkspaceWriterRegistry();
  registry.begin("session-a", "/work/project");

  assert.throws(
    () => registry.begin("session-a", "/work/other"),
    /already owns another workspace/,
  );
});
