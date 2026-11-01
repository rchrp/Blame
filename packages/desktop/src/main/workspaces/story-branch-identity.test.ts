import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoryBranch } from "./story-branch-identity.ts";

const base = "blame/story-US-004-untitled-user-story";
const storyId = "3f9c2a1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f";
const existing =
  (...branches: string[]) =>
  async (branch: string) =>
    branches.includes(branch);

test("a new story keeps the plain name when nothing uses it", async () => {
  assert.deepEqual(
    await resolveStoryBranch({ base, exists: existing(), storyId }),
    { branch: base, suffix: "" },
  );
});

test("a new story does not inherit an earlier story's branch", async () => {
  // JuliettePortfolio, added to Blame again: US-004 met September's branch.
  assert.deepEqual(
    await resolveStoryBranch({ base, exists: existing(base), storyId }),
    { branch: `${base}-3f9c2a1e`, suffix: "-3f9c2a1e" },
  );
});

test("a story finds its own branch again", async () => {
  assert.deepEqual(
    await resolveStoryBranch({
      base,
      exists: existing(base),
      recordedBranch: base,
      storyId,
    }),
    { branch: base, suffix: "" },
  );
  // Recorded or not, the id-named branch is this story's.
  assert.deepEqual(
    await resolveStoryBranch({
      base,
      exists: existing(base, `${base}-3f9c2a1e`),
      storyId,
    }),
    { branch: `${base}-3f9c2a1e`, suffix: "-3f9c2a1e" },
  );
  // A story that ran in Direct mode recorded the project's branch.
  assert.deepEqual(
    await resolveStoryBranch({
      base,
      exists: existing(base),
      recordedBranch: "main",
      storyId,
    }),
    { branch: `${base}-3f9c2a1e`, suffix: "-3f9c2a1e" },
  );
});
