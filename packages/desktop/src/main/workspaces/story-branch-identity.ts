// A story's branch is named after its number and title. When a folder is
// added to Blame again, numbering starts over, and a new story can meet the
// branch an earlier story of the same number left behind: checking it out
// would build the new story on that story's old code (JuliettePortfolio,
// 2026-11-01). A branch of that name is the story's own only when the story
// recorded it; otherwise the story takes a name made unique by its id and
// starts from the project's current code.
export async function resolveStoryBranch(input: {
  base: string;
  exists: (branch: string) => Promise<boolean>;
  recordedBranch?: string | null;
  storyId: string;
}) {
  const { base, recordedBranch } = input;
  // The story's own branch, plain or made unique on an earlier run.
  if (recordedBranch === base || recordedBranch?.startsWith(`${base}-`)) {
    const suffix = recordedBranch.slice(base.length);
    return { branch: recordedBranch, suffix };
  }
  const suffix = `-${storyIdSuffix(input.storyId)}`;
  const own = `${base}${suffix}`;
  if (await input.exists(own)) return { branch: own, suffix };
  return (await input.exists(base))
    ? { branch: own, suffix }
    : { branch: base, suffix: "" };
}

// Story ids are UUIDv7: their first digits are a timestamp that stories
// created minutes apart share, their last ones are random.
function storyIdSuffix(storyId: string) {
  const compact = storyId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.slice(-8) || "story";
}
