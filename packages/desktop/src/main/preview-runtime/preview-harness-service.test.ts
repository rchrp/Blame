import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewLifecycleState } from "@blame/preview-contract";
import type { PreviewDevtoolsTarget } from "../preview-browser/preview-browser-manager.ts";
import {
  previewHarnessState,
  resolvePreviewHarnessState,
  shouldProbePreviewApplication,
  shouldStartStoppedLocalPreview,
} from "./preview-harness-state.ts";

test("ready requests startup for a stopped local managed preview", () => {
  assert.equal(
    shouldStartStoppedLocalPreview({
      status: "stopped",
      waitFor: "ready",
      workspaceMode: "local-container",
      worktree: "/workspace",
    }),
    true,
  );
  assert.equal(
    shouldStartStoppedLocalPreview({
      status: "stopped",
      waitFor: "none",
      workspaceMode: "local-container",
      worktree: "/workspace",
    }),
    false,
  );
  assert.equal(
    shouldStartStoppedLocalPreview({
      status: "stopped",
      waitFor: "ready",
      workspaceMode: "cloud-mirror",
      worktree: "/workspace",
    }),
    false,
  );
});

test("stopped previews return immediately even when ready was requested", async () => {
  let refreshes = 0;

  const state = await resolvePreviewHarnessState(
    async () => previewHarnessState(browserTarget(), idleLifecycle()),
    "ready",
    async () => {
      refreshes += 1;
    },
  );

  assert.equal(state.status, "stopped");
  assert.equal(state.available, false);
  assert.equal(refreshes, 0);
});

test("a ready preview is available to the agent whatever the panel shows", async () => {
  const state = await resolvePreviewHarnessState(
    async () => previewHarnessState(browserTarget(true), readyLifecycle()),
    "ready",
    async () => {
      assert.fail("A ready preview must not wait");
    },
  );
  assert.equal(state.status, "ready");
  assert.equal(state.available, true);
  assert.notEqual(state.reason, "PREVIEW_BROWSER_HIDDEN");
  assert.deepEqual(state.readiness, {
    browser_ready: true,
    container_ready: true,
    application_ready: true,
  });
});

test("managed startup waiting still reports starting", () => {
  const state = previewHarnessState(browserTarget(true), startingLifecycle());
  assert.equal(state.status, "starting");
  assert.equal(state.reason, "PREVIEW_STARTING");
});

test("failed previews return immediately with their failure", async () => {
  const state = previewHarnessState(browserTarget(), {
    failure: { message: "Web container exited" },
    phase: "failed",
    since: new Date().toISOString(),
    status: "error",
  });

  assert.equal(state.status, "failed");
  assert.equal(state.reason, "PREVIEW_FAILED");
  assert.equal(state.message, "Web container exited");
});

test("HTTP 500 preview diagnostics fail without a readiness wait", async () => {
  let refreshes = 0;
  const state = await resolvePreviewHarnessState(
    async () =>
      previewHarnessState(
        {
          ...browserTarget(true),
          application: {
            status: "failed",
            httpStatus: 500,
            diagnostic: "Failed to compile: module not found",
          },
        },
        readyLifecycle(),
      ),
    "ready",
    async () => {
      refreshes += 1;
    },
  );
  assert.equal(state.status, "failed");
  assert.equal(state.readiness.application_ready, false);
  assert.match(state.message, /module not found/iu);
  assert.equal(refreshes, 0);
});

test("an application probe failure remains transient during startup", () => {
  const state = previewHarnessState(
    {
      ...browserTarget(true),
      application: {
        status: "failed",
        diagnostic: "Preview application probe timed out.",
      },
    },
    startingLifecycle(),
  );

  assert.equal(state.status, "starting");
  assert.equal(state.reason, "PREVIEW_STARTING");
});

test("application probing starts only after the runtime is ready", () => {
  assert.equal(shouldProbePreviewApplication(startingLifecycle()), false);
  assert.equal(shouldProbePreviewApplication(readyLifecycle()), true);
  assert.equal(shouldProbePreviewApplication(failedLifecycle()), true);
});

test("ready waits only while the preview is actively starting", async () => {
  let browserInspections = 0;
  let lifecycleInspections = 0;

  const state = await resolvePreviewHarnessState(
    async () =>
      previewHarnessState(
        browserTarget(++browserInspections > 1),
        ++lifecycleInspections > 1 ? readyLifecycle() : startingLifecycle(),
      ),
    "ready",
    async () => undefined,
  );

  assert.equal(state.status, "ready");
  assert.equal(state.available, true);
  assert.equal(state.reason, "PREVIEW_APPLICATION_READY");
  assert.equal(state.readiness.application_ready, true);
});

test("startup may exceed the running application readiness budget", async () => {
  let inspections = 0;
  let now = 0;
  const state = await resolvePreviewHarnessState(
    async () =>
      ++inspections > 3
        ? previewHarnessState(browserTarget(true), readyLifecycle())
        : previewHarnessState(browserTarget(false, true), startingLifecycle()),
    "ready",
    async () => {
      now += 10 * 60_000;
    },
    undefined,
    { applicationTimeoutMs: 2_000, now: () => now },
  );

  assert.equal(state.status, "ready");
  assert.equal(now, 30 * 60_000);
});

test("an explicit startup failure returns immediately", async () => {
  let inspections = 0;
  let refreshes = 0;
  const state = await resolvePreviewHarnessState(
    async () =>
      ++inspections > 1
        ? previewHarnessState(browserTarget(), failedLifecycle())
        : previewHarnessState(browserTarget(false, true), startingLifecycle()),
    "ready",
    async () => {
      refreshes += 1;
    },
  );

  assert.equal(state.status, "failed");
  assert.equal(state.reason, "PREVIEW_FAILED");
  assert.equal(refreshes, 1);
});

test("none returns the current starting state without refreshing", async () => {
  let refreshes = 0;

  const state = await resolvePreviewHarnessState(
    async () =>
      previewHarnessState(browserTarget(false, true), startingLifecycle()),
    "none",
    async () => {
      refreshes += 1;
    },
  );

  assert.equal(state.status, "starting");
  assert.equal(refreshes, 0);
});

test("ready bounds a running preview that never becomes application-ready", async () => {
  let now = 0;
  let refreshes = 0;
  const state = await resolvePreviewHarnessState(
    async () =>
      previewHarnessState(browserTarget(false, true), readyLifecycle()),
    "ready",
    async () => {
      now += 500;
      refreshes += 1;
    },
    undefined,
    { applicationTimeoutMs: 1_000, now: () => now },
  );

  assert.equal(state.status, "unavailable");
  assert.equal(state.reason, "PREVIEW_APPLICATION_TIMEOUT");
  assert.equal(state.available, false);
  assert.equal(refreshes, 2);
});

test("ready runtime without a browser view is immediately unavailable", async () => {
  let refreshes = 0;

  const state = await resolvePreviewHarnessState(
    async () => previewHarnessState(browserTarget(), readyLifecycle()),
    "ready",
    async () => {
      refreshes += 1;
    },
  );

  assert.equal(state.status, "unavailable");
  assert.equal(state.reason, "PREVIEW_BROWSER_NOT_OPEN");
  assert.equal(refreshes, 0);
});

test("stopping is non-waitable", () => {
  const state = previewHarnessState(browserTarget(true), {
    phase: "stopping",
    since: new Date().toISOString(),
    status: "pending",
  });

  assert.equal(state.status, "stopped");
  assert.equal(state.available, false);
});

function browserTarget(available = false, loading = false) {
  return {
    ...(available
      ? { application: { status: "ready" as const, httpStatus: 200 } }
      : {}),
    available,
    ...(available || loading ? { currentUrl: "http://127.0.0.1:3000/" } : {}),
    loading,
  } satisfies PreviewDevtoolsTarget;
}

function idleLifecycle(): PreviewLifecycleState {
  return { phase: "idle", since: new Date().toISOString(), status: "idle" };
}

function startingLifecycle(): PreviewLifecycleState {
  return {
    phase: "starting",
    since: new Date().toISOString(),
    status: "pending",
  };
}

function failedLifecycle(): PreviewLifecycleState {
  return {
    failure: { message: "Preview startup failed" },
    phase: "failed",
    since: new Date().toISOString(),
    status: "error",
  };
}

function readyLifecycle(): PreviewLifecycleState {
  return { phase: "ready", since: new Date().toISOString(), status: "ready" };
}
