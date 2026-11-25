import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { approveAndMerge } from "../git/story-merge.js";
import type { GitAgent } from "../git/agent.js";
import type { Epic, EpicState } from "../protocol.js";
import type { HostStory } from "../stories/story.js";
import { checkedOutAt, reviewEpic, type ReviewHost } from "./review.js";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

const model = { providerId: "anthropic", modelId: "m" };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// A project on main whose epic branch holds one merged story.
async function project() {
  const directory = await mkdtemp(join(tmpdir(), "blame-epic-review-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "blame@example.com"]);
  await git(root, ["config", "user.name", "Blame Test"]);
  await writeFile(join(root, "readme.md"), "hello\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["branch", "epic/site", "main"]);
  const story = join(directory, "story");
  await git(root, ["worktree", "add", story, "epic/site"]);
  await writeFile(join(story, "page.tsx"), "export const page = 1\n");
  await git(story, ["add", "."]);
  await git(story, ["commit", "-m", "feat: the page"]);
  await git(root, ["worktree", "remove", story]);
  return root;
}

function setup(
  root: string,
  stories: Array<Pick<HostStory, "status" | "storyNumber">>,
  state: Partial<EpicState> = {},
) {
  const epic: Epic = {
    id: "e1",
    projectId: "p1",
    title: "Site",
    goal: "A site.",
    status: "active",
    branch: "epic/site",
    targetBranch: "main",
    engineSessionId: "s1",
    settings: {},
    mergedAt: null,
    mergeCommit: null,
  };
  const patches: unknown[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Partial<Epic>;
    patches.push(body);
    Object.assign(epic, body);
    return new Response(JSON.stringify({ data: epic }));
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = inner;
  });
  const agent: GitAgent = async () => {
    throw new Error("No agent in this test.");
  };
  const calls: string[] = [];
  const host: ReviewHost = {
    api: () => ({ url: "http://api.test", token: "t" }) as never,
    stories: { refresh: async () => undefined } as never,
    git,
    call: (async (method: string, input: never) => {
      calls.push(method);
      if (method === "approveAndMerge") return approveAndMerge(input, agent);
      throw new Error(`unexpected ${method}`);
    }) as ReviewHost["call"],
  };
  const orchestrator = {
    reading: async () =>
      ({
        epic: { ...epic },
        entry: {
          branch: "epic/site",
          settings: { workspace: { root }, model },
        },
        epicStories: () => stories,
      }) as never,
    epicState: async () =>
      ({ conversation: "finished", summary: "The site.", ...state }) as never,
    changed: async () => ({}) as never,
    orchestratorModel: () => model,
  };
  return { orchestrator, host, patches, calls };
}

describe("reviewEpic", () => {
  it("merges the epic's branch into its target and marks the epic merged", async () => {
    const root = await project();
    const epicHead = await git(root, ["rev-parse", "epic/site"]);
    const { orchestrator, host, patches } = setup(root, [
      { status: "done", storyNumber: 5 },
      { status: "discarded", storyNumber: 6 },
    ]);
    const result = await reviewEpic(orchestrator, host, {
      epicId: "e1",
      action: "merge",
    });
    assert.equal(result.action, "merge");
    assert.equal(await git(root, ["rev-parse", "main"]), epicHead);
    assert.equal(
      await git(root, ["show", "main:page.tsx"]),
      "export const page = 1",
    );
    const patch = patches.at(-1) as Partial<Epic>;
    assert.equal(patch.status, "completed");
    assert.equal(patch.mergeCommit, epicHead);
    assert.ok(patch.mergedAt);
    // The temporary checkout of the epic's branch is gone.
    const worktrees = await git(root, ["worktree", "list", "--porcelain"]);
    assert.equal(checkedOutAt(worktrees, "epic/site"), undefined);
  });

  it("refuses while a story is neither merged nor rejected, or the orchestrator works", async () => {
    const root = await project();
    const open = setup(root, [
      { status: "done", storyNumber: 5 },
      { status: "in-review", storyNumber: 8 },
    ]);
    await assert.rejects(
      reviewEpic(open.orchestrator, open.host, {
        epicId: "e1",
        action: "merge",
      }),
      /US-008 is neither merged nor rejected yet/,
    );
    const working = setup(root, [{ status: "done", storyNumber: 5 }], {
      conversation: "working",
    });
    await assert.rejects(
      reviewEpic(working.orchestrator, working.host, {
        epicId: "e1",
        action: "merge",
      }),
      /The orchestrator is working/,
    );
    assert.deepEqual([...open.calls, ...working.calls], []);
    assert.notEqual(
      await git(root, ["rev-parse", "main"]),
      await git(root, ["rev-parse", "epic/site"]),
    );
  });

  it("finds where a branch is checked out", () => {
    const listing = [
      "worktree /p",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /w",
      "HEAD def",
      "branch refs/heads/epic/site",
    ].join("\n");
    assert.equal(checkedOutAt(listing, "epic/site"), "/w");
    assert.equal(checkedOutAt(listing, "epic/other"), undefined);
  });
});
