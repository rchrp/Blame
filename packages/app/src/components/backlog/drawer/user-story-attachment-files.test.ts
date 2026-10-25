import assert from "node:assert/strict"
import test from "node:test"

import {
  pendingFileAttachments,
  replaceFileAttachments,
} from "./user-story-attachment-files.ts"

test("preserves stored attachment references while editing", () => {
  const attachment = {
    downloadUrl: "https://storage.example/attachment",
    id: "attachment-id",
    name: "attachment.txt",
    size: 42,
    type: "text/plain",
  }

  const [pending] = pendingFileAttachments([attachment])

  assert.equal(pending?.file.size, 0)
  assert.equal(pending?.previewUrl, undefined)
  assert.equal(pending?.storedAttachment, attachment)
})

test("uses an image preview only for image attachments", () => {
  const attachment = {
    downloadUrl: "https://storage.example/image",
    id: "image-id",
    name: "preview.png",
    size: 42,
    type: "image/png",
  }

  const [pending] = pendingFileAttachments([attachment])

  assert.equal(pending?.previewUrl, attachment.downloadUrl)
  assert.equal(pending?.storedAttachment, attachment)
})

test("annotation replacements keep order, preserve unrelated files and use new upload identities", () => {
  const original = {
    id: "old",
    name: "image.jpg",
    type: "image/jpeg",
    size: 5,
    downloadUrl: "https://storage.example/old",
  }
  const other = {
    id: "other",
    name: "notes.txt",
    type: "text/plain",
    size: 5,
    content: "SGVsbG8=",
  }
  const annotated = {
    id: "new",
    name: "image-annotated.png",
    type: "image/png",
    size: 10,
    content: "YW5ub3RhdGVk",
  }
  const result = replaceFileAttachments(
    [original, other],
    [{ id: original.id, attachment: annotated }]
  )
  assert.deepEqual(result, [annotated, other])
  assert.equal(result[1], other)
  assert.equal(result[0].downloadUrl, undefined)
  assert.equal(original.id, "old")
  assert.deepEqual(
    replaceFileAttachments(
      [other],
      [{ id: original.id, attachment: annotated }]
    ),
    [other]
  )
})
