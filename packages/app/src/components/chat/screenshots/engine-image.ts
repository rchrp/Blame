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
      const type =
        response.headers.get("x-blob-media-type") ??
        response.headers.get("content-type")
      if (!type?.startsWith("image/")) return null
      return new Blob([await response.arrayBuffer()], { type })
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
