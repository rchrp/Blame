import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import {
  configureStoredAttachmentUrls,
  currentDownloadUrl,
  downloadUrlExpired,
  downloadUrlExpiresAt,
  freshDownloadUrl,
  renewRefusedDownloadUrl,
} from "./stored-attachment-url.ts"

const originalFetch = globalThis.fetch
let apiCount = 0

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Each test talks to its own API so earlier renewals never leak into it.
function useApi(urls: string[]) {
  const requests: string[] = []
  apiCount += 1
  configureStoredAttachmentUrls({
    url: `https://api${apiCount}.example`,
    token: "token",
  })
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    const downloadUrl = urls.shift()
    if (!downloadUrl) return new Response("{}", { status: 404 })
    return Response.json({
      data: { id: "a", name: "a.png", size: 1, type: "image/png", downloadUrl },
    })
  }
  return requests
}

function signed(date: string, lifetime = 900) {
  return `https://storage.example/a.png?X-Amz-Date=${date}&X-Amz-Expires=${lifetime}&X-Amz-Signature=s`
}

test("reads the expiry of S3 signed links", () => {
  const url = signed("20261107T173500Z")
  assert.equal(downloadUrlExpiresAt(url), Date.UTC(2026, 10, 7, 17, 50, 0))
  assert.equal(downloadUrlExpired(url, Date.UTC(2026, 10, 7, 17, 40)), false)
  assert.equal(downloadUrlExpired(url, Date.UTC(2026, 10, 7, 17, 49, 30)), true)
  assert.equal(downloadUrlExpiresAt("https://storage.example/a.png"), undefined)
  assert.equal(downloadUrlExpired("blob:local"), false)
})

test("keeps a link that is still valid without asking the API", async () => {
  const requests = useApi([])
  const url = signed("20990101T000000Z")
  assert.equal(await freshDownloadUrl({ id: "a", downloadUrl: url }), url)
  assert.deepEqual(requests, [])
})

test("renews an expired link once and remembers the new one", async () => {
  const expired = signed("20200101T000000Z")
  const renewed = signed("20990101T000000Z")
  const requests = useApi([renewed])
  const attachment = { id: "a", downloadUrl: expired }
  const [first, second] = await Promise.all([
    freshDownloadUrl(attachment),
    freshDownloadUrl(attachment),
  ])
  assert.equal(first, renewed)
  assert.equal(second, renewed)
  assert.equal(currentDownloadUrl(attachment), renewed)
  assert.equal(requests.length, 1)
  assert.match(requests[0], /\/attachments\/a$/)
})

test("prefers a newer link from a reload over an older renewal", async () => {
  const renewed = signed("20990101T000000Z")
  useApi([renewed])
  await freshDownloadUrl({ id: "a", downloadUrl: signed("20200101T000000Z") })
  const reloaded = signed("20990101T001000Z")
  assert.equal(currentDownloadUrl({ id: "a", downloadUrl: reloaded }), reloaded)
})

test("renews a refused link only once", async () => {
  const refused = "https://storage.example/a.png"
  const renewed = signed("20990101T000000Z")
  const requests = useApi([renewed])
  const attachment = { id: "a", downloadUrl: refused }
  assert.equal(await renewRefusedDownloadUrl(attachment, refused), renewed)
  assert.equal(await renewRefusedDownloadUrl(attachment, refused), undefined)
  assert.equal(requests.length, 1)
})

test("falls back to the known link when the API cannot renew it", async () => {
  useApi([])
  const expired = signed("20200101T000000Z")
  assert.equal(
    await freshDownloadUrl({ id: "a", downloadUrl: expired }),
    expired
  )
})
