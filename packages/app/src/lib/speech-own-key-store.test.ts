import assert from "node:assert/strict"
import test from "node:test"

import type { SpeechOwnKeyStatus } from "@blame/speech-contract"
import type { SpeechOwnKeyClient } from "../context/platform-speech-key.ts"
import {
  createSpeechOwnKeyStore,
  ownSpeechKeyAccess,
} from "./speech-own-key-store.ts"

const status = (configured: boolean): SpeechOwnKeyStatus => ({
  configured,
  defaultModel: "openai/gpt-transcribe",
  lastFour: configured ? "2c3d" : undefined,
  storageAvailable: true,
})

function client(answers: Array<SpeechOwnKeyStatus | Error>) {
  let reads = 0
  const fake = {
    async status() {
      const answer = answers[Math.min(reads, answers.length - 1)]
      reads += 1
      if (answer instanceof Error) throw answer
      return answer
    },
  } as unknown as SpeechOwnKeyClient
  return { fake, reads: () => reads }
}

test("reads the desktop once and serves the answer from the cache", async () => {
  const { fake, reads } = client([status(true)])
  const store = createSpeechOwnKeyStore(fake)
  assert.equal(store.snapshot(), undefined)
  assert.equal((await store.current())?.configured, true)
  assert.equal((await store.current())?.configured, true)
  assert.equal(reads(), 1)
})

test("shares one read between callers that ask at the same time", async () => {
  const { fake, reads } = client([status(true)])
  const store = createSpeechOwnKeyStore(fake)
  await Promise.all([store.refresh(), store.refresh(), store.current()])
  assert.equal(reads(), 1)
})

test("refreshes after a change and tells those who listen", async () => {
  const { fake } = client([status(false), status(true)])
  const store = createSpeechOwnKeyStore(fake)
  let notified = 0
  const unsubscribe = store.subscribe(() => (notified += 1))
  await store.refresh()
  assert.equal(ownSpeechKeyAccess(store.snapshot()), "unset")
  await store.refresh()
  assert.equal(ownSpeechKeyAccess(store.snapshot()), "set")
  store.set(status(false))
  assert.equal(ownSpeechKeyAccess(store.snapshot()), "unset")
  assert.equal(notified, 3)
  unsubscribe()
  store.set(status(true))
  assert.equal(notified, 3)
})

test("keeps the last answer when the desktop cannot be read", async () => {
  const { fake } = client([status(true), new Error("ipc failed")])
  const store = createSpeechOwnKeyStore(fake)
  await store.refresh()
  assert.equal((await store.refresh())?.configured, true)
  assert.equal(ownSpeechKeyAccess(store.snapshot()), "set")
})

test("knows nothing of a key where none can be kept", () => {
  assert.equal(ownSpeechKeyAccess(undefined), undefined)
})
