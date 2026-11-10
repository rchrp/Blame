import assert from "node:assert/strict"
import test from "node:test"

import {
  commitDirectStory,
  directCommitMessageRequest,
  directCommitValidationError,
  storySessionIds,
  type DirectStoryCommitDependencies,
  type SharedFilesChoice,
} from "./direct-story-commit.ts"

const story = {
  agentRuns: [
    { clineSessionId: "run-1" },
    { clineSessionId: "run-2" },
    { clineSessionId: null },
  ],
  clineSessionId: "run-2",
} as never

function fakes(
  files: { path: string; shared: boolean }[],
  options: { choice?: SharedFilesChoice; commitError?: Error } = {}
) {
  const calls: unknown[][] = []
  const dependencies: DirectStoryCommitDependencies = {
    agent: {
      directStoryFiles: async (input) => {
        calls.push(["directStoryFiles", input])
        return { files }
      },
    },
    confirmSharedFiles: async (shared) => {
      calls.push(["confirmSharedFiles", shared.map((file) => file.path)])
      return options.choice ?? "commit"
    },
    generateMessage: async (paths) => {
      calls.push(["generateMessage", paths])
      return "feat(app): story work"
    },
    workspace: {
      gitCommit: async (input) => {
        calls.push(["gitCommit", input])
        if (options.commitError) throw options.commitError
        return { output: "" }
      },
      gitLog: async () => [
        { hash: "story-commit", parents: ["previous-commit"] },
      ] as never,
    },
  }
  return { calls, dependencies }
}

test("commits the story's own files without asking, with a message about them", async () => {
  const { calls, dependencies } = fakes([
    { path: "a.ts", shared: false },
    { path: "b.ts", shared: false },
  ])

  const result = await commitDirectStory(story, "/project", dependencies)

  assert.deepEqual(result, {
    status: "committed",
    baseCommit: "previous-commit",
    commit: "story-commit",
    fileCount: 2,
    message: "feat(app): story work",
  })
  assert.deepEqual(calls, [
    [
      "directStoryFiles",
      { root: "/project", sessionIds: ["run-1", "run-2"] },
    ],
    ["generateMessage", ["a.ts", "b.ts"]],
    [
      "gitCommit",
      {
        message: "feat(app): story work",
        paths: ["a.ts", "b.ts"],
        root: "/project",
      },
    ],
  ])
})

test("asks about files that also hold other changes before committing them", async () => {
  const files = [
    { path: "a.ts", shared: false },
    { path: "b.ts", shared: true },
  ]
  const committed = (choice: SharedFilesChoice) => {
    const { calls, dependencies } = fakes(files, { choice })
    return commitDirectStory(story, "/project", dependencies).then(
      (result) => ({ calls, result })
    )
  }

  const withThem = await committed("commit")
  assert.deepEqual(withThem.calls[1], ["confirmSharedFiles", ["a.ts", "b.ts"]])
  assert.deepEqual(withThem.calls[2], ["generateMessage", ["a.ts", "b.ts"]])

  const withoutThem = await committed("leave-out")
  assert.deepEqual(withoutThem.calls[2], ["generateMessage", ["a.ts"]])
  assert.equal(withoutThem.result.status, "committed")

  const cancelled = await committed("cancel")
  assert.deepEqual(cancelled.result, { status: "cancelled" })
  assert.equal(
    cancelled.calls.some(([name]) => name === "gitCommit"),
    false
  )
})

test("commits nothing when the person leaves out the only files there are", async () => {
  const { calls, dependencies } = fakes([{ path: "b.ts", shared: true }], {
    choice: "leave-out",
  })

  assert.deepEqual(await commitDirectStory(story, "/project", dependencies), {
    status: "cancelled",
  })
  assert.equal(
    calls.some(([name]) => name === "gitCommit"),
    false
  )
})

test("says why when no change of the story is left to commit", async () => {
  const { calls, dependencies } = fakes([])

  await assert.rejects(
    commitDirectStory(story, "/project", dependencies),
    /None of the story's changes are left in the project folder/
  )
  assert.equal(
    calls.some(([name]) => name === "gitCommit"),
    false
  )
})

test("lets a failed commit surface its error", async () => {
  const { dependencies } = fakes([{ path: "a.ts", shared: false }], {
    commitError: new Error("pre-commit hook failed"),
  })

  await assert.rejects(
    commitDirectStory(story, "/project", dependencies),
    /pre-commit hook failed/
  )
})

test("asks for a message that closes the GitHub issues the story handles", () => {
  const issue = "https://github.com/acme/shop/issues/12"
  assert.deepEqual(
    directCommitMessageRequest(
      { title: "Pay by card", summary: `Traite la GitHub issue [12](${issue}).` },
      "/project",
      ["a.ts"]
    ),
    {
      repositoryRoot: "/project",
      worktree: "/project",
      selectedPaths: ["a.ts"],
      title: "Pay by card",
      summary: `Traite la GitHub issue [12](${issue}).`,
      closeLinkedIssues: true,
    }
  )
})

test("collects each session of the story once", () => {
  assert.deepEqual(storySessionIds(story), ["run-1", "run-2"])
  assert.deepEqual(storySessionIds({} as never), [])
})

test("needs a project folder, a signed-in provider, a model and the desktop runtime", () => {
  const agent = { directStoryFiles: () => {}, generateCommitMessage: () => {} }
  const workspace = { gitCommit: () => {}, gitLog: () => {} }
  const error = (
    storyInput: { worktree: string | null },
    authStatus: string,
    runtime: unknown,
    model: unknown
  ) =>
    directCommitValidationError(
      storyInput,
      authStatus,
      runtime as never,
      workspace as never,
      model
    )

  assert.equal(error({ worktree: "/project" }, "authenticated", agent, {}), undefined)
  assert.match(error({ worktree: null }, "authenticated", agent, {}) ?? "", /no project folder/)
  assert.match(error({ worktree: "/project" }, "signed-out", agent, {}) ?? "", /Reconnect/)
  assert.match(error({ worktree: "/project" }, "authenticated", agent, undefined) ?? "", /Select a model/)
  assert.match(error({ worktree: "/project" }, "authenticated", undefined, {}) ?? "", /not available/)
})
