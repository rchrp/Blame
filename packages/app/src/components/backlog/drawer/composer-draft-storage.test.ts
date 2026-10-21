import assert from "node:assert/strict"
import test from "node:test"

import {
  appendComposerDraftText,
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraft,
} from "./composer-draft-storage.ts"

const draft: ComposerDraft = {
  markdown: "Work in progress",
  codeSelectionAttachments: [
    {
      id: "code",
      content: "const value = 1",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
    },
  ],
  fileAttachments: [
    {
      id: "file",
      content: "aGVsbG8=",
      name: "note.txt",
      size: 5,
      type: "text/plain",
    },
  ],
}

test("creates separate keys for new and existing chat and backlog drafts", () => {
  assert.notEqual(
    composerDraftStorageKey("project", "chat"),
    composerDraftStorageKey("project", "chat", "chat-1")
  )
  assert.notEqual(
    composerDraftStorageKey("project", "chat", "chat-1"),
    composerDraftStorageKey("project", "backlog", "story-1")
  )
})

test("round trips markdown and attachments", () => {
  let stored: string | null = null
  const storage = {
    getItem: () => stored,
    removeItem: () => {
      stored = null
    },
    setItem: (_key: string, value: string) => {
      stored = value
    },
  }
  writeComposerDraft(storage, "draft", draft)
  assert.deepEqual(readComposerDraft(storage, "draft"), draft)
})

test("removes empty drafts and ignores invalid stored data", () => {
  let removed = false
  writeComposerDraft(
    {
      removeItem: () => {
        removed = true
      },
      setItem: () => assert.fail("should not persist"),
    },
    "draft",
    { markdown: "", codeSelectionAttachments: [], fileAttachments: [] }
  )
  assert.equal(removed, true)
  assert.equal(
    readComposerDraft({ getItem: () => '{"markdown":1}' }, "draft"),
    undefined
  )
})

test("appends a dictation to an existing or missing draft", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
  appendComposerDraftText(storage, "empty", " Add tests. ")
  assert.equal(readComposerDraft(storage, "empty")?.markdown, "Add tests.")
  writeComposerDraft(storage, "draft", draft)
  appendComposerDraftText(storage, "draft", "Then ship.")
  const updated = readComposerDraft(storage, "draft")
  assert.equal(updated?.markdown, "Work in progress Then ship.")
  assert.deepEqual(updated?.fileAttachments, draft.fileAttachments)
})
