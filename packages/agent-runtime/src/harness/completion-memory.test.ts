import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  leaveCompletionMemory,
  takeCompletionMemory,
} from "./completion-memory.js";
import { createProjectMemoryCandidate } from "./project-memory.js";

it("hands a finish's memory to the host once, per session", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-memory-"));
  try {
    const memory = createProjectMemoryCandidate({
      files: [{ hash: "h", path: "src/a.ts" }],
      objective: "Add a greeting",
      sourceRevisionId: "rev",
      summary: "Added it.",
      symbols: ["greet"],
    });
    await leaveCompletionMemory(root, "session-a", memory);
    assert.equal(await takeCompletionMemory(root, "session-b"), undefined);
    assert.deepEqual(await takeCompletionMemory(root, "session-a"), memory);
    assert.equal(await takeCompletionMemory(root, "session-a"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
