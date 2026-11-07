import type { ApiConnection } from "@blame/agent-runtime"
import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import { fetchFileAttachment } from "../../lib/file-attachment-api.ts"
import type { ComposerAttachment } from "./attachment-types"

// Stored attachments are served through signed links that expire (15 minutes
// on hosted storage), while the app keeps them for as long as it runs. Ask the
// API for a new link shortly before the old one expires, or once storage
// refuses it.
type StoredAttachment = Pick<UserStoryFileAttachment, "id" | "downloadUrl">

const renewalMarginMs = 60_000

let connection: ApiConnection | undefined
const renewed = new Map<string, string>()
const pending = new Map<string, Promise<string | undefined>>()
const refused = new Set<string>()
const listeners = new Set<() => void>()

export function configureStoredAttachmentUrls(next: ApiConnection) {
  if (next.url === connection?.url && next.token === connection?.token) return
  connection = next
  renewed.clear()
  pending.clear()
  refused.clear()
  notify()
}

export function subscribeStoredAttachmentUrls(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The known link that stays valid the longest. */
export function currentDownloadUrl(attachment: StoredAttachment) {
  const stored = attachment.downloadUrl
  const fresh = renewed.get(attachment.id)
  if (!fresh || !stored) return fresh ?? stored
  return (downloadUrlExpiresAt(fresh) ?? 0) >=
    (downloadUrlExpiresAt(stored) ?? 0)
    ? fresh
    : stored
}

/** The stored original an image card shows, if its link can be renewed. */
export function renewableImage(attachment: ComposerAttachment) {
  const stored = attachment.storedAttachment
  return stored?.downloadUrl && attachment.previewUrl === stored.downloadUrl
    ? stored
    : undefined
}

/** The link to show for an image card. */
export function attachmentImageUrl(attachment: ComposerAttachment) {
  const stored = renewableImage(attachment)
  return stored ? currentDownloadUrl(stored) : attachment.previewUrl
}

/** Renews the expired image links a gallery is about to load. */
export async function renewExpiredImages(attachments: ComposerAttachment[]) {
  await Promise.all(
    attachments.map((attachment) => {
      const stored = renewableImage(attachment)
      return stored && freshDownloadUrl(stored)
    })
  )
}

/** A link that still works: the known one, or a new one from the API. */
export async function freshDownloadUrl(attachment: StoredAttachment) {
  const current = currentDownloadUrl(attachment)
  if (current && !downloadUrlExpired(current)) return current
  return (await renewDownloadUrl(attachment.id)) ?? current
}

/** Renews a link storage refused, once per link so a missing file stops there. */
export function renewRefusedDownloadUrl(
  attachment: StoredAttachment,
  url: string
) {
  if (!connection || refused.has(url)) return Promise.resolve(undefined)
  refused.add(url)
  return renewDownloadUrl(attachment.id)
}

export function downloadUrlExpired(url: string, now = Date.now()) {
  const expiresAt = downloadUrlExpiresAt(url)
  return expiresAt !== undefined && expiresAt - renewalMarginMs <= now
}

// S3 signatures carry their start (X-Amz-Date) and lifetime (X-Amz-Expires).
export function downloadUrlExpiresAt(url: string) {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return undefined
  }
  const date = params
    .get("X-Amz-Date")
    ?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  const lifetime = params.get("X-Amz-Expires")
  if (!date || lifetime === null || !/^\d+$/.test(lifetime)) return undefined
  const [year, month, day, hour, minute, second] = date.slice(1).map(Number)
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) +
    Number(lifetime) * 1000
  )
}

function renewDownloadUrl(id: string) {
  const active = pending.get(id)
  if (active) return active
  const current = connection
  if (!current) return Promise.resolve(undefined)
  const request = fetchFileAttachment(current, id)
    .then((attachment) => {
      const url = attachment.downloadUrl
      if (url && connection === current) {
        renewed.set(id, url)
        notify()
      }
      return url
    })
    .catch(() => undefined)
    .finally(() => {
      if (pending.get(id) === request) pending.delete(id)
    })
  pending.set(id, request)
  return request
}

function notify() {
  listeners.forEach((listener) => listener())
}
