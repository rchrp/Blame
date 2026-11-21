import assert from "node:assert/strict"
import test from "node:test"

import {
  agentLastErrorLimit,
  BacklogApiError,
  createBacklogApi,
} from "./backlog-api.ts"
import {
  startsAfterChoices,
  startsAfterEntries,
  type UserStoryDraft,
  userStoryReadyForAgent,
} from "./backlog-data.ts"
import { storyDependencyName, storyWaitText } from "./story-queue-waits.ts"

test("bounds the agent's last error before sending a story update", async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return Response.json({ data: story })
  }

  try {
    const api = createBacklogApi({ url: "http://localhost:3333/api/v1" })
    await api.update(story.id, {
      agentLastError: "x".repeat(agentLastErrorLimit + 500),
    })
    assert.equal(String(requestBody.agentLastError).length, agentLastErrorLimit)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("surfaces structured validation errors as non-retryable", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json(
      {
        errors: [
          {
            message:
              "The agentLastError field must not be greater than 4096 characters",
          },
        ],
      },
      { status: 422 }
    )

  try {
    const api = createBacklogApi({ url: "http://localhost:3333/api/v1" })
    await assert.rejects(
      api.update(story.id, { agentLastError: "invalid" }),
      (error) =>
        error instanceof BacklogApiError &&
        error.status === 422 &&
        !error.retryable &&
        error.message.includes("agentLastError")
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("creates a queued story before uploading its attachments", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ body?: string; method: string; url: string }> = []
  const attachment = {
    content: "SGVsbG8=",
    id: "attachment-id",
    name: "attachment.txt",
    size: 5,
    type: "text/plain",
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method ?? "GET",
      url,
    })
    if (url.endsWith("/projects/user-stories") && init?.method === "POST") {
      return Response.json({
        data: {
          ...story,
          fileAttachmentUploadPending: true,
          status: "ready",
        },
      })
    }
    if (url.endsWith("/attachments/uploads")) {
      return Response.json({
        attachment: { ...attachment, content: undefined },
        upload: {
          expiresAt: "2026-07-25T12:15:00.000Z",
          headers: { "Content-Type": "text/plain" },
          url: "https://storage.example/upload",
        },
      })
    }
    if (url === "https://storage.example/upload") return new Response(null)
    if (url.endsWith("/attachments/attachment-id/complete")) {
      return Response.json({ ...attachment, content: undefined })
    }
    return Response.json({
      data: {
        ...story,
        fileAttachments: [{ ...attachment, content: undefined }],
        fileAttachmentUploadPending: false,
        status: "ready",
      },
    })
  }

  try {
    const api = createBacklogApi({ url: "http://localhost:3333/api/v1" })
    const input: UserStoryDraft = {
      fileAttachments: [attachment],
      projectId: "project-1",
      status: "ready",
      summary: "Summary",
      title: "Title",
    }
    const creation = await api.create(input)

    assert.equal(requests.length, 1)
    assert.equal(JSON.parse(requests[0]?.body ?? "{}").status, "ready")
    assert.equal(
      JSON.parse(requests[0]?.body ?? "{}").fileAttachmentUploadPending,
      true
    )
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}").fileAttachments, [])
    assert.equal(creation.story.status, "ready")
    assert.equal(creation.story.fileAttachmentUploadStatus, "uploading")
    assert.equal(userStoryReadyForAgent(creation.story), true)
    assert.equal(
      userStoryReadyForAgent({
        ...creation.story,
        fileAttachments: [],
        fileAttachmentUploadStatus: undefined,
      }),
      false
    )
    assert.ok(creation.completeAttachmentUpload)

    const uploadedStory = await creation.completeAttachmentUpload()

    assert.deepEqual(
      requests.map(({ method, url }) => ({ method, url })),
      [
        {
          method: "POST",
          url: "http://localhost:3333/api/v1/projects/user-stories",
        },
        {
          method: "POST",
          url: "http://localhost:3333/api/v1/attachments/uploads",
        },
        { method: "PUT", url: "https://storage.example/upload" },
        {
          method: "POST",
          url: "http://localhost:3333/api/v1/attachments/attachment-id/complete",
        },
        {
          method: "PATCH",
          url: "http://localhost:3333/api/v1/projects/user-stories/story-1",
        },
      ]
    )
    assert.equal(userStoryReadyForAgent(uploadedStory), true)
    assert.equal(uploadedStory.fileAttachmentUploadPending, false)
    assert.deepEqual(JSON.parse(requests[4]?.body ?? "{}"), {
      fileAttachments: [
        {
          id: attachment.id,
          name: attachment.name,
          size: attachment.size,
          type: attachment.type,
        },
      ],
      fileAttachmentUploadPending: false,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("saves the stories a story starts after, and says why the API refused them", async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  let refuse = false
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return refuse
      ? Response.json(
          {
            message:
              "Story story-2 already waits for this story: waiting for it would close a cycle",
            code: "E_STORY_DEPENDENCY_INVALID",
          },
          { status: 422 }
        )
      : Response.json({
          data: { ...story, startsAfter: requestBody.startsAfter },
        })
  }

  try {
    const api = createBacklogApi({ url: "http://localhost:3333/api/v1" })
    const saved = await api.update(story.id, { startsAfter: ["story-2"] })
    assert.deepEqual(requestBody.startsAfter, ["story-2"])
    assert.deepEqual(saved.startsAfter, ["story-2"])
    await api.update(story.id, { startsAfter: [] })
    assert.deepEqual(requestBody.startsAfter, [])
    refuse = true
    await assert.rejects(
      api.update(story.id, { startsAfter: ["story-2"] }),
      (error) =>
        error instanceof BacklogApiError &&
        error.status === 422 &&
        !error.retryable &&
        error.message.startsWith("Story story-2 already waits for this story")
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("lists a story's dependencies, even those since discarded or deleted", () => {
  const stories = [
    { id: "a", status: "backlog", storyNumber: 4, title: "Base" },
    { id: "b", status: "discarded", storyNumber: 5, title: "Dropped" },
    { id: "c", status: "done", storyNumber: 6, title: "Shipped" },
    { id: "me", status: "backlog", storyNumber: 7, title: "Me" },
  ] as const
  const entries = startsAfterEntries(["b", "gone", "a", "b"], stories)
  assert.deepEqual(
    entries.map(({ id, story }) => [id, story?.status]),
    [
      ["b", "discarded"],
      ["gone", undefined],
      ["a", "backlog"],
    ]
  )
  assert.deepEqual(startsAfterEntries(undefined, stories), [])
  assert.deepEqual(
    startsAfterChoices(stories, "me").map(({ id }) => id),
    ["c", "a"],
    "newest first, never itself, never a discarded story"
  )
  // The card and the field name a story the same way.
  assert.equal(storyDependencyName(stories[0]), "US-004 Base")
  assert.equal(storyDependencyName({}), "a deleted story")
  assert.equal(
    storyWaitText({
      kind: "dependencies",
      storyIds: ["a"],
      stories: [{ id: "a", storyNumber: 4, title: "Base", status: "backlog" }],
    }),
    "Starts after US-004 Base"
  )
})

const story = {
  agentRuns: [],
  codeSelectionAttachments: [],
  comments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  fileAttachments: [],
  id: "story-1",
  owner: "Product",
  priority: "medium",
  projectId: "project-1",
  status: "in-progress",
  storyNumber: 1,
  summary: "Summary",
  title: "Title",
}
