import assert from "node:assert/strict"
import test from "node:test"

import type { UserStory } from "./backlog-data.ts"
import { mergeLoadedStories } from "./backlog-store-merge.ts"

test("keeps a local attachment upload pending during a server refresh", () => {
  const localStory = {
    ...story(),
    fileAttachments: [
      {
        content: "SGVsbG8=",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
    fileAttachmentUploadPending: true,
    fileAttachmentUploadStatus: "uploading" as const,
    status: "ready" as const,
  }
  const serverStory = {
    ...story(),
    fileAttachments: [],
    fileAttachmentUploadPending: true,
    status: "ready" as const,
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const [merged] = mergeLoadedStories([localStory], [serverStory])

  assert.equal(merged?.status, "ready")
  assert.equal(merged?.fileAttachmentUploadStatus, "uploading")
  assert.equal(merged?.fileAttachmentUploadPending, true)
  assert.equal(merged?.fileAttachments?.[0]?.content, "SGVsbG8=")
})

test("keeps persisted attachment content in memory after upload", () => {
  const localStory = {
    ...story(),
    fileAttachments: [
      {
        content: "SGVsbG8=",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
  }
  const serverStory = {
    ...story(),
    fileAttachments: [
      {
        downloadUrl: "https://storage.example/attachment",
        id: "attachment",
        name: "attachment.txt",
        size: 5,
        type: "text/plain",
      },
    ],
    updatedAt: "2026-06-11T10:00:04.000Z",
  }

  const [merged] = mergeLoadedStories([localStory], [serverStory])

  assert.equal(merged?.fileAttachments?.[0]?.content, "SGVsbG8=")
  assert.equal(
    merged?.fileAttachments?.[0]?.downloadUrl,
    "https://storage.example/attachment"
  )
})

function story(): UserStory {
  return {
    createdAt: "2026-06-11T10:00:00.000Z",
    id: 1,
    owner: "Product",
    priority: "Medium",
    projectId: "project",
    status: "in-progress",
    summary: "",
    title: "Story",
    updatedAt: "2026-06-11T10:00:03.000Z",
  }
}
