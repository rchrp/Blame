import type { ApiConnection } from "@blame/agent-runtime"

const replicationDelays = [250, 750, 1500, 3000, 6000]

export async function readEngineImage(
  connection: ApiConnection,
  id: string,
  signal: AbortSignal
) {
  if (!/^[0-9a-f]{64}$/u.test(id)) return null
  const url = `${connection.url.replace(/\/$/u, "")}/engine/blobs/${id}`
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: connection.token
        ? { Authorization: `Bearer ${connection.token}` }
        : {},
      signal,
    })
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      // The API sends `application/octet-stream` and names the type in
      // `x-blob-media-type`, which a page on another origin only sees when
      // the API exposes it: the image's first bytes say it too.
      const named =
        response.headers.get("x-blob-media-type") ??
        response.headers.get("content-type")
      const type = named?.startsWith("image/") ? named : imageType(bytes)
      if (!type) return null
      return new Blob([bytes], { type })
    }
    const delay = replicationDelays[attempt]
    if (response.status !== 404 || delay === undefined) return null
    // The transcript record can arrive before the blob replication completes.
    await waitForReplication(delay, signal)
  }
}

function waitForReplication(delay: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, delay)
    function abort() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** The type of a PNG, JPEG, GIF or WebP image from its signature. */
export function imageType(bytes: Uint8Array) {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte)
  const ascii = (from: number, text: string) =>
    [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0))
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif"
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp"
  return undefined
}
