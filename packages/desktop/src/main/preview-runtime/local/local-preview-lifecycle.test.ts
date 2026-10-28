import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime";
import type { PreviewRuntimeSelectionState } from "../../preview-run-state.ts";
import {
  localPreviewLifecycle,
  parseLocalPreviewRuntimeSelectionState,
  persistLocalPreviewFailure,
  persistLocalPreviewResult,
  suspendedLocalPreviewLifecycle,
  validPreviewLifecycle,
  selectsBrowserPreview,
} from "./local-preview-lifecycle.ts";

test("projects local container and endpoint observations to the shared lifecycle", () => {
  const starting = selection("running", "starting");
  assert.equal(
    localPreviewLifecycle(starting, "starting", true, undefined).phase,
    "starting",
  );
  assert.equal(
    localPreviewLifecycle(starting, "running", true, undefined).phase,
    "loading",
  );
  assert.equal(
    localPreviewLifecycle(starting, "running", true, "http://127.0.0.1:3000")
      .phase,
    "ready",
  );
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

test("persists local completion and failures through one selection contract", async () => {
  const writes: PreviewRuntimeSelectionState[] = [];
  const write = async (
    _worktree: string,
    state: PreviewRuntimeSelectionState,
  ) => {
    writes.push(state);
  };
  const result = {
    configurations: [],
    desiredStatus: "running",
    lifecycle: {
      phase: "ready",
      status: "ready",
      since: new Date().toISOString(),
    },
    selectedConfigurationId: "web",
    statuses: {},
  } satisfies ProjectPreviewRuntimeState;

  await persistLocalPreviewResult("/workspace", result, write);
  await persistLocalPreviewFailure(
    "/workspace",
    "web",
    "running",
    new Error("compose failed"),
    write,
  );

  assert.equal(writes[0]?.lifecycle?.phase, "ready");
  assert.deepEqual(writes[1]?.lifecycle?.failure, {
    message: "compose failed",
  });
  assert.equal(validPreviewLifecycle(writes[1]?.lifecycle), true);
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
    localPreviewLifecycle(starting, "starting", true, undefined).step,
    "Downloading container images",
  );
  assert.equal(
    localPreviewLifecycle(starting, "running", true, "http://localhost:3000/")
      .step,
    undefined,
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
    localPreviewLifecycle(suspended, "running", true, undefined).phase,
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
