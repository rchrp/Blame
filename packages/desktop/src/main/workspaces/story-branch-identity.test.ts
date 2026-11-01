import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoryBranch } from "./story-branch-identity.ts";

const base = "blame/story-US-004-untitled-user-story";
const storyId = "019a3f9c-2a1e-7b4d-9c1f-0a1b2c3d4e5f";
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
    { branch: `${base}-2c3d4e5f`, suffix: "-2c3d4e5f" },
  );
  // UUIDv7 ids created minutes apart share their leading timestamp.
  const neighbour = await resolveStoryBranch({
    base,
    exists: existing(base),
    storyId: "019a3f9c-2b07-7e11-8a42-9f8e7d6c5b4a",
  });
  assert.equal(neighbour.branch, `${base}-7d6c5b4a`);
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
      exists: existing(base, `${base}-2c3d4e5f`),
      storyId,
    }),
    { branch: `${base}-2c3d4e5f`, suffix: "-2c3d4e5f" },
  );
  // Named by 1.2.2-beta.4 from the id's first digits: kept with its folder.
  assert.deepEqual(
    await resolveStoryBranch({
      base,
      exists: existing(base, `${base}-019a3f9c`),
      recordedBranch: `${base}-019a3f9c`,
      storyId,
    }),
    { branch: `${base}-019a3f9c`, suffix: "-019a3f9c" },
  );
  // A story that ran in Direct mode recorded the project's branch.
  assert.deepEqual(
    await resolveStoryBranch({
      base,
      exists: existing(base),
      recordedBranch: "main",
      storyId,
    }),
    { branch: `${base}-2c3d4e5f`, suffix: "-2c3d4e5f" },
  );
});
