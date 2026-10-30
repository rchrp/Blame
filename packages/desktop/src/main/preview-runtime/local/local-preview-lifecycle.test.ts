import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewRuntimeSelectionState } from "../../preview-run-state.ts";
import {
  localPreviewLifecycle,
  parseLocalPreviewRuntimeSelectionState,
  localPreviewOperationInFlight,
  persistLocalPreviewFailure,
  readyLocalPreviewLifecycle,
  runLocalPreviewOperation,
  suspendedLocalPreviewLifecycle,
  validPreviewLifecycle,
  selectsBrowserPreview,
} from "./local-preview-lifecycle.ts";

test("reports ready only once the start that owns the preview settled", () => {
  const starting = selection("running", "starting");
  // While the start runs, running containers do not make it ready.
  assert.equal(
    localPreviewLifecycle(starting, "running", true, "http://x/", true).phase,
    "starting",
  );
  // A pending start no operation owns any more was interrupted.
  const interrupted = localPreviewLifecycle(starting, "running", true, "x");
  assert.equal(interrupted.status, "error");
  assert.match(interrupted.failure?.message ?? "", /interrupted/);
  const ready = { ...starting, lifecycle: readyLocalPreviewLifecycle() };
  assert.equal(
    localPreviewLifecycle(ready, "running", true, "http://x/").phase,
    "ready",
  );
  // Settled, then its services stopped: a failure, never a new wait.
  assert.equal(
    localPreviewLifecycle(ready, "stopped", true, undefined).status,
    "error",
  );
  assert.equal(
    localPreviewLifecycle(ready, "error", true, "x").status,
    "error",
  );
});

test("a selected preview nobody started yet is idle, not starting", () => {
  const selected: PreviewRuntimeSelectionState = {
    desiredStatus: "running",
    selectedConfigurationId: "web",
  };
  assert.equal(
    localPreviewLifecycle(selected, "stopped", false, undefined).phase,
    "idle",
  );
});

test("an operation settles the lifecycle unless a newer request took over", async () => {
  const writes: PreviewRuntimeSelectionState[] = [];
  let current: PreviewRuntimeSelectionState = { desiredStatus: "stopped" };
  const write = async (_: string, state: PreviewRuntimeSelectionState) => {
    writes.push(state);
    current = state;
  };
  const read = async () => current;
  let inFlight = false;
  await runLocalPreviewOperation(
    "/w",
    "web",
    "running",
    "starting",
    async () => {
      inFlight = localPreviewOperationInFlight("/w");
      return readyLocalPreviewLifecycle();
    },
    write,
    read,
  );
  assert.equal(inFlight, true);
  assert.equal(localPreviewOperationInFlight("/w"), false);
  assert.deepEqual(
    writes.map(({ lifecycle }) => lifecycle?.phase),
    ["starting", "ready"],
  );
  // A stop arrived during the start: the start writes nothing more.
  await runLocalPreviewOperation(
    "/w",
    "web",
    "running",
    "starting",
    async () => {
      current = { desiredStatus: "stopped" };
      throw new Error("compose failed");
    },
    write,
    read,
  ).catch(() => undefined);
  assert.equal(current.desiredStatus, "stopped");
});

test("rejects stale runtime state instead of defaulting it to running", () => {
  assert.throws(
    () => parseLocalPreviewRuntimeSelectionState({}),
    /desiredStatus is invalid/,
  );
  assert.throws(
    () =>
      parseLocalPreviewRuntimeSelectionState({
        desiredStatus: "running",
        legacyPreview: true,
      }),
    /unsupported field legacyPreview/,
  );
  assert.deepEqual(
    parseLocalPreviewRuntimeSelectionState({
      desiredStatus: "stopped",
      selectedConfigurationId: "web",
    }),
    { desiredStatus: "stopped", selectedConfigurationId: "web" },
  );
});

test("persists failures as readable lifecycle errors", async () => {
  const writes: PreviewRuntimeSelectionState[] = [];
  const write = async (_: string, state: PreviewRuntimeSelectionState) => {
    writes.push(state);
  };
  await persistLocalPreviewFailure(
    "/workspace",
    "web",
    "running",
    new Error("compose failed"),
    write,
  );
  assert.deepEqual(writes[0]?.lifecycle?.failure, {
    message: "compose failed",
  });
  assert.equal(validPreviewLifecycle(writes[0]?.lifecycle), true);
});

function selection(
  desiredStatus: PreviewRuntimeSelectionState["desiredStatus"],
  phase: "starting" | "stopping",
): PreviewRuntimeSelectionState {
  return {
    desiredStatus,
    lifecycle: {
      phase,
      status: "pending",
      since: new Date().toISOString(),
    },
    selectedConfigurationId: "web",
  };
}

test("reports the step of a starting preview until its phase changes", () => {
  const starting = {
    desiredStatus: "running" as const,
    selectedConfigurationId: "web",
    lifecycle: {
      phase: "starting" as const,
      status: "pending" as const,
      since: "2026-10-24T10:00:00.000Z",
      step: "Downloading container images",
    },
  };
  assert.equal(
    localPreviewLifecycle(starting, "starting", true, undefined, true).step,
    "Downloading container images",
  );
});

test("keeps the start step of a lifecycle valid", () => {
  const lifecycle = {
    phase: "starting",
    status: "pending",
    since: new Date().toISOString(),
    step: "Starting the app services",
  };
  assert.equal(validPreviewLifecycle(lifecycle), true);
  assert.equal(validPreviewLifecycle({ ...lifecycle, step: 3 }), false);
});

test("keeps a preview stopped for lack of use suspended", () => {
  const suspended: PreviewRuntimeSelectionState = {
    desiredStatus: "stopped",
    lifecycle: suspendedLocalPreviewLifecycle(),
  };
  assert.equal(
    localPreviewLifecycle(suspended, "stopped", true, undefined).phase,
    "suspended",
  );
  assert.equal(
    localPreviewLifecycle(suspended, "running", true, undefined, true).phase,
    "stopping",
  );
  const stopped: PreviewRuntimeSelectionState = { desiredStatus: "stopped" };
  assert.equal(
    localPreviewLifecycle(stopped, "stopped", true, undefined).phase,
    "idle",
  );
});

test("only web surfaces wait for a preview URL", () => {
  const manifest = {
    services: [
      { id: "web" },
      { id: "phone", surface: { type: "web" } },
      { id: "cli", surface: { type: "terminal" } },
      { id: "app", surface: { type: "display" } },
    ],
  };
  assert.equal(selectsBrowserPreview("web", manifest), true);
  assert.equal(selectsBrowserPreview("phone", manifest), true);
  assert.equal(selectsBrowserPreview("cli", manifest), false);
  assert.equal(selectsBrowserPreview("app", manifest), false);
  assert.equal(selectsBrowserPreview(undefined, manifest), false);
});
