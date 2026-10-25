import assert from "node:assert/strict"
import test from "node:test"

import type {
  DesktopUpdatesClient,
  DesktopUpdateStatus,
} from "../../context/platform.ts"
import { createDesktopUpdateStore } from "./desktop-update-store.ts"

function status(
  phase: DesktopUpdateStatus["phase"],
  progress?: number
): DesktopUpdateStatus {
  return {
    phase,
    progress,
    channel: "stable",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(initial = status("available")) {
  let current = initial
  const listeners = new Set<(value: DesktopUpdateStatus) => void>()
  const calls = { download: 0, restart: 0, check: 0 }
  const client: DesktopUpdatesClient = {
    getStatus: async () => current,
    onStatus: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    check: async () => {
      calls.check++
      return emit(status("available"))
    },
    download: async () => {
      calls.download++
      return emit(status("downloaded"))
    },
    install: async () => {
      calls.restart++
      return current
    },
    setChannel: async () => current,
  }
  function emit(next: DesktopUpdateStatus) {
    current = next
    listeners.forEach((listener) => listener(next))
    return next
  }
  const store = createDesktopUpdateStore(client)
  return { client, store, emit, calls, listeners }
}

test("does not overwrite live progress with a late startup snapshot", async () => {
  const f = fixture()
  const snapshot = deferred<DesktopUpdateStatus>()
  f.client.getStatus = () => snapshot.promise
  const disconnect = f.store.connect()
  f.emit(status("downloading", 42))
  snapshot.resolve(status("available"))
  await snapshot.promise
  assert.equal(f.store.getSnapshot().status.progress, 42)
  disconnect()
  assert.equal(f.listeners.size, 0)
})

test("ignores an initial response after the window disconnects", async () => {
  const f = fixture()
  const snapshot = deferred<DesktopUpdateStatus>()
  f.client.getStatus = () => snapshot.promise
  f.store.connect()()
  snapshot.resolve(status("available"))
  await snapshot.promise
  assert.equal(f.store.getSnapshot().status.phase, "unsupported")
})

test("coalesces both install entry points and keeps restart locked until exit", async () => {
  const f = fixture()
  f.store.connect()
  await Promise.resolve()
  const download = deferred<DesktopUpdateStatus>()
  f.client.download = () => {
    f.calls.download++
    return download.promise
  }
  const first = f.store.download()
  assert.equal(f.store.download(), first)
  await Promise.resolve()
  assert.equal(f.calls.download, 1)
  f.emit(status("downloading", 56))
  assert.equal(f.store.getSnapshot().pending, "download")
  assert.equal(f.store.getSnapshot().status.progress, 56)
  f.emit(status("downloaded"))
  download.resolve(status("available"))
  await first
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
  assert.equal(f.store.getSnapshot().pending, undefined)
  await f.store.restart()
  await f.store.restart()
  assert.equal(f.calls.restart, 1)
  assert.equal(f.store.getSnapshot().pending, "restart")
})

test("follows an update started from Settings without starting another download", async () => {
  const f = fixture()
  f.store.connect()
  f.emit(status("downloading", 73))
  await f.store.download()
  assert.equal(f.calls.download, 0)
  assert.equal(f.store.getSnapshot().status.progress, 73)
  f.emit(status("downloaded"))
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
})

test("a failed background download can be checked and retried from either entry point", async () => {
  const f = fixture()
  f.store.connect()
  f.emit(status("downloading", 20))
  f.emit({ ...status("error"), error: "Connection interrupted" })
  assert.deepEqual(f.store.getSnapshot().failure, {
    action: "download",
    message: "Connection interrupted",
  })
  await f.store.retry()
  assert.equal(f.calls.check, 1)
  assert.equal(f.calls.download, 1)
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
  assert.equal(f.store.getSnapshot().failure, undefined)
})

test("restart failure preserves the downloaded update and retries only the restart", async () => {
  const f = fixture(status("downloaded"))
  f.store.connect()
  await Promise.resolve()
  f.client.install = async () => {
    throw new Error("Could not prepare shutdown")
  }
  await f.store.restart()
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
  assert.equal(f.store.getSnapshot().failure?.action, "restart")
  assert.equal(f.store.getSnapshot().pending, undefined)
  f.client.install = async () => {
    f.calls.restart++
    return status("downloaded")
  }
  await f.store.retry()
  assert.equal(f.calls.restart, 1)
  assert.equal(f.calls.download, 0)
  assert.equal(f.calls.check, 0)
})

test("reports an IPC failure and allows a later download retry", async () => {
  const f = fixture()
  f.store.connect()
  await Promise.resolve()
  f.client.download = async () => {
    throw new Error("Desktop unavailable")
  }
  await f.store.download()
  assert.equal(f.store.getSnapshot().failure?.message, "Desktop unavailable")
  assert.equal(f.store.getSnapshot().pending, undefined)
  f.client.download = async () => f.emit(status("downloaded"))
  await f.store.retry()
  assert.equal(f.store.getSnapshot().failure, undefined)
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
})

test("recovers a native preparation failure after the download completes", async () => {
  const f = fixture(status("downloaded"))
  f.store.connect()
  await Promise.resolve()
  f.emit({ ...status("error"), error: "Could not prepare the update" })
  assert.equal(f.store.getSnapshot().failure?.action, "download")
  await f.store.retry()
  assert.equal(f.calls.check, 1)
  assert.equal(f.calls.download, 1)
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
})

test("a native restart error fetches the update again instead of retrying an invalid installer", async () => {
  const f = fixture(status("downloaded"))
  f.store.connect()
  await Promise.resolve()
  f.client.install = async () =>
    f.emit({ ...status("error"), error: "Installer unavailable" })
  await f.store.restart()
  assert.equal(f.store.getSnapshot().failure?.action, "download")
  assert.equal(f.store.getSnapshot().pending, undefined)
  await f.store.retry()
  assert.equal(f.calls.download, 1)
  assert.equal(f.store.getSnapshot().status.phase, "downloaded")
})

test("web and secondary windows do not expose update actions", async () => {
  const store = createDesktopUpdateStore()
  store.connect()
  await store.download()
  await store.restart()
  assert.equal(store.getSnapshot().status.phase, "unsupported")
  assert.equal(store.getSnapshot().pending, undefined)
})
