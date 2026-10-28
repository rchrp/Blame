import assert from "node:assert/strict";
import test from "node:test";

import {
  initializationProgress,
  initializationToolLabel,
  type InitializationProgress,
} from "./initialization-progress.js";
import type { AgentEvent } from "./types.js";

test("reports monotonic progress on the run's channel", () => {
  const events: AgentEvent[] = [];
  const progress = initializationProgress(
    { emit: (event) => events.push(event) },
    { progressId: "run-1" },
    10,
  );
  progress.scanning();
  progress.analyzing();
  progress.tool("read_files");
  progress.tool("search_codebase");
  progress.checking(1);
  progress.rejected(
    1,
    new Error(
      "Initialization result previewManifest must run detected database migrations before starting backend services",
    ),
  );
  progress.tool("submit_project_initialization");
  progress.checking(2);
  const payloads = events.map(
    ({ payload }) => payload as InitializationProgress,
  );
  assert.ok(
    events.every(({ sessionId }) => sessionId === "initialization:run-1"),
  );
  const percents = payloads.map(({ percent }) => percent);
  assert.deepEqual(
    [...percents].sort((a, b) => a - b),
    percents,
  );
  assert.equal(payloads[2]!.label, "Reading project files");
  const correcting = payloads.find(({ phase }) => phase === "correcting")!;
  assert.equal(correcting.label, "Fixing the setup · 2 of 10");
  assert.equal(payloads.at(-1)!.phase, "checking");
  assert.equal(
    correcting.detail,
    "The setup must run detected database migrations before starting backend services.",
  );
});

test("stays silent without a progress channel", () => {
  const events: AgentEvent[] = [];
  const progress = initializationProgress(
    { emit: (event) => events.push(event) },
    {},
    3,
  );
  progress.scanning();
  progress.tool("read_files");
  assert.equal(events.length, 0);
});

test("names tool calls for people", () => {
  assert.equal(
    initializationToolLabel("submit_project_initialization"),
    "Writing the preview setup",
  );
  assert.equal(initializationToolLabel("run_commands"), "Running a command");
});
