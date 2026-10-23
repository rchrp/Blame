import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime";
import type { PreviewRuntimeSelectionState } from "../../preview-run-state.ts";
import {
  localPreviewLifecycle,
  parseLocalPreviewRuntimeSelectionState,
  persistLocalPreviewFailure,
  persistLocalPreviewResult,
  validPreviewLifecycle,
  localPreviewStartStep,
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

test("names the start steps people can follow and keeps them valid", () => {
  assert.equal(
    localPreviewStartStep("compose setup service db-migrate"),
    "Running setup task db-migrate",
  );
  assert.equal(
    localPreviewStartStep("compose up"),
    "Starting the app services",
  );
  assert.equal(localPreviewStartStep("dependency cache check deps"), undefined);
  const lifecycle = {
    phase: "starting",
    status: "pending",
    since: new Date().toISOString(),
    step: "Starting the app services",
  };
  assert.equal(validPreviewLifecycle(lifecycle), true);
  assert.equal(validPreviewLifecycle({ ...lifecycle, step: 3 }), false);
});
