import assert from "node:assert/strict"
import { test } from "node:test"
import { readAttachmentFile } from "./attachment-file.ts"
import { configureStoredAttachmentUrls } from "./stored-attachment-url.ts"

test("reads uploaded originals instead of their empty File placeholders", async () => {
  const file = new File([], "restored.md", { type: "text/markdown" })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("# Restored original")
  try {
    const restored = await readAttachmentFile({
      id: "1",
      file,
      source: "file",
      storedAttachment: {
        id: "1",
        name: file.name,
        type: file.type,
        size: 19,
        downloadUrl: "https://example.test/file",
      },
    })
    assert.equal(await restored.text(), "# Restored original")
    assert.equal(restored.name, file.name)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("enforces download bounds even if metadata understates size", async () => {
  const file = new File([], "large.txt")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("too much content")
  try {
    await assert.rejects(
      readAttachmentFile(
        {
          id: "1",
          file,
          source: "file",
          storedAttachment: {
            id: "1",
            name: file.name,
            type: "text/plain",
            size: 1,
            downloadUrl: "https://example.test/file",
          },
        },
        4
      ),
      /too large/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("refuses missing originals and oversized local previews", async () => {
  const file = new File(["content"], "local.txt")
  await assert.rejects(
    readAttachmentFile({ id: "1", file, source: "file" }, 1),
    /too large/
  )
  await assert.rejects(
    readAttachmentFile({
      id: "1",
      file,
      source: "file",
      storedAttachment: {
        id: "1",
        name: file.name,
        type: "text/plain",
        size: 7,
      },
    }),
    /unavailable/
  )
})

test("retries an original storage refused with a renewed link", async () => {
  const file = new File([], "restored.md", { type: "text/markdown" })
  const refused = "https://storage.example/old"
  const renewed = "https://storage.example/new"
  const requests: string[] = []
  const originalFetch = globalThis.fetch
  configureStoredAttachmentUrls({ url: "https://api.example", token: "t" })
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === refused) return new Response("", { status: 403 })
    if (url === renewed) return new Response("# Renewed")
    return Response.json({
      data: {
        id: "1",
        name: file.name,
        size: 9,
        type: file.type,
        downloadUrl: renewed,
      },
    })
  }
  try {
    const restored = await readAttachmentFile({
      id: "1",
      file,
      source: "file",
      storedAttachment: {
        id: "1",
        name: file.name,
        type: file.type,
        size: 9,
        downloadUrl: refused,
      },
    })
    assert.equal(await restored.text(), "# Renewed")
    assert.deepEqual(requests, [
      refused,
      "https://api.example/attachments/1",
      renewed,
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
