import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewHarnessState } from "./preview-harness-state.ts";
import { PreviewLogService } from "./preview-log-reader.ts";

test("stopped preview logs return before reading compose metadata", async () => {
  let reads = 0;
  const service = new PreviewLogService(async () => {
    reads += 1;
    return { available: true, services: ["web"] };
  });

  const result = await service.read(
    { worktree: "/workspace" },
    previewState("stopped"),
  );

  assert.equal(reads, 0);
  assert.equal(result.available, false);
  assert.equal(result.reason, "PREVIEW_STOPPED");
  assert.equal(result.message, "The preview is not running.");
});

test("failed preview logs remain available for diagnosis", async () => {
  let reads = 0;
  const service = new PreviewLogService(async (input) => {
    reads += 1;
    assert.equal(input.timeoutMs, 3_000);
    return { available: true, services: ["web"], stdout: "failure" };
  });

  const result = await service.read(
    { worktree: "/workspace" },
    previewState("failed"),
  );

  assert.equal(reads, 1);
  assert.equal(result.available, true);
  assert.equal(result.preview.status, "failed");
});

function previewState(
  status: PreviewHarnessState["status"],
): PreviewHarnessState {
  return {
    available: status === "ready",
    loading: status === "starting",
    mcp: {
      enabledCapabilities: [],
      pageScoped: true,
      unavailableCapabilities: [],
      version: "1.8.0",
    },
    message:
      status === "stopped"
        ? "The preview is not running."
        : "The preview failed.",
    reason: status === "stopped" ? "PREVIEW_STOPPED" : "PREVIEW_FAILED",
    readiness: {
      browser_ready: status === "ready",
      container_ready: status === "ready",
      application_ready: status === "ready",
    },
    status,
  };
}
