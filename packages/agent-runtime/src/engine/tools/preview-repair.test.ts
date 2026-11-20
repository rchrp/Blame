import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewManifest } from "../../types.js";
import type { RepairProjectInitializationTask } from "../task-protocol.js";
import { storyPreviewRepair } from "./preview-repair.js";

const manifest = (root: string) =>
  ({
    confidence: "high",
    project: { root },
    setup: [],
    services: [],
    caches: [],
    risks: [],
    probes: [],
  }) as unknown as PreviewManifest;

const story = {
  model: { providerId: "anthropic", modelId: "claude" },
  projectId: "project",
  initialization: { previewManifest: manifest("."), runConfigurations: [] },
};
const preview = {
  worktree: "/tmp/story",
  storyId: "story-1",
  workspaceMode: "local-container" as const,
};

test("a story's repair runs the task for its worktree, applies it and keeps it", async () => {
  const repairs: RepairProjectInitializationTask[] = [];
  const applied: unknown[] = [];
  const repair = storyPreviewRepair(
    {
      previewDevtools: async () => ({ message: "Port 5432 refused." }) as never,
      repairInitialization: async (input) => {
        repairs.push(input);
        return {
          session: `task-${repairs.length}`,
          classification: "repairable_initialization",
          reason: "A database service was introduced.",
          previewManifest: manifest(`v${repairs.length}`),
          runConfigurations: [],
        };
      },
      applyPreviewInitialization: async (input) => {
        applied.push(input);
        return { status: "applied" };
      },
    },
    story,
  );
  assert.ok(repair);
  assert.deepEqual(await repair(preview), {
    classification: "repairable_initialization",
    reason: "A database service was introduced.",
    status: "applied",
  });
  assert.equal(repairs[0]!.workspace.root, "/tmp/story");
  assert.match(JSON.stringify(repairs[0]!.diagnostics), /Port 5432 refused\./);
  assert.deepEqual(applied[0], {
    databaseMode: "compose",
    previewManifest: manifest("v1"),
    reason: "A database service was introduced.",
    repairSessionId: "task-1",
    runConfigurations: [],
    storyId: "story-1",
    worktree: "/tmp/story",
    workspaceMode: "local-container",
  });
  await repair(preview);
  assert.deepEqual(
    repairs[1]!.previewManifest,
    manifest("v1"),
    "the next repair starts from the applied setup",
  );
});

test("a repair without a new setup applies nothing", async () => {
  let applied = false;
  const repair = storyPreviewRepair(
    {
      repairInitialization: async () => ({
        session: "task",
        classification: "project_code_failure",
        reason: "The app crashes on start.",
      }),
      applyPreviewInitialization: async () => {
        applied = true;
        return { status: "applied" };
      },
    },
    story,
  );
  assert.equal((await repair!(preview)).status, "not_repairable");
  assert.equal(applied, false);
});

test("no repair is offered without its services or a saved setup", () => {
  const run = async () => ({ status: "applied" as const });
  assert.equal(
    storyPreviewRepair({ applyPreviewInitialization: run }, story),
    undefined,
  );
  assert.equal(
    storyPreviewRepair(
      {
        applyPreviewInitialization: run,
        repairInitialization: async () => ({}) as never,
      },
      undefined,
    ),
    undefined,
  );
});
