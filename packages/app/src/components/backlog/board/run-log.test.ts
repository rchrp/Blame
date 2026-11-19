import assert from "node:assert/strict"
import test from "node:test"

import { runLogEvents, runLogStreams } from "../../../bench/run-log-streams.ts"
import type { RunLogsClient } from "../../../context/platform-run-logs.ts"
import { terminalText } from "../../../lib/terminal-text.ts"
import {
  firstPagesLines,
  firstWindow,
  heldWindow,
  pageBelow,
  RunLog,
  runLogPageLines,
  windowText,
  windowWithPageAbove,
  windowWithPageBelow,
  type RunLogSnapshot,
} from "./run-log.ts"

// The desktop's store, in memory.
function desktop() {
  const calls: string[] = []
  let text = ""
  const client: RunLogsClient = {
    append: (_id, lines) => {
      text += lines
    },
    close: (id) => calls.push(`close ${id}`),
    copy: async (_id, before, after, endsSelection) => {
      const lines = endsSelection ? text.replace(/\n$/, "") : text
      calls.push(`copy ${before}${lines}${after}`)
    },
    read: async (_id, from, to) =>
      text.split("\n").slice(0, -1).slice(from, to),
  }
  return { calls, client, text: () => text }
}

function frames() {
  const callbacks: (() => void)[] = []
  return {
    paint: () => callbacks.splice(0).forEach((callback) => callback()),
    pending: () => callbacks.length,
    schedule: (callback: () => void) => callbacks.push(callback),
  }
}

test("the desktop gets every line, the log keeps the last ones", async () => {
  for (const kind of runLogStreams) {
    const store = desktop()
    const log = new RunLog(store.client, frames().schedule)
    const events = runLogEvents(kind, 5)
    let raw = ""
    for (let index = 0; index < 4_000; index += 1) {
      const event = events.next().value as string
      raw += event
      // Chunks cut anywhere.
      const cut = index % event.length
      log.push(event.slice(0, cut))
      log.push(event.slice(cut))
    }
    const snapshot = log.snapshot()
    const all = await log.read(0, Number.MAX_SAFE_INTEGER)
    assert.equal(
      all.map((line) => `${line}\n`).join("") + snapshot.tail,
      terminalText(raw)
    )
    assert.ok(snapshot.pages.length <= 5)
    const kept = snapshot.pages.flat()
    assert.equal(snapshot.first * runLogPageLines + kept.length, all.length)
    assert.deepEqual(kept, all.slice(snapshot.first * runLogPageLines))
    assert.equal(
      log.recentText(500),
      windowText(snapshot).slice(-500),
      "the end of what the panel shows"
    )
  }
})

test("panels hear of new output once a frame", () => {
  const scheduler = frames()
  const log = new RunLog(desktop().client, scheduler.schedule)
  let heard = 0
  const stop = log.subscribe(() => (heard += 1))
  const first = log.snapshot()
  for (let index = 0; index < 100; index += 1) log.push(`line ${index}\n`)
  assert.equal(scheduler.pending(), 1)
  scheduler.paint()
  assert.equal(heard, 1)
  assert.notEqual(log.snapshot(), first)
  assert.equal(log.snapshot(), log.snapshot())
  stop()
  log.push("unheard\n")
  assert.equal(scheduler.pending(), 0)
})

test("copying puts the whole output between what surrounds it", async () => {
  const store = desktop()
  const log = new RunLog(store.client, frames().schedule)
  log.push("$ pnpm dev\nready\nwaiting")
  await log.copy("before ", " after", false)
  // Ending the selection, the last newline goes if the output ends a line.
  await log.copy("", "", true)
  log.push("\n")
  await log.copy("", "", true)
  assert.deepEqual(store.calls, [
    "copy before $ pnpm dev\nready\nwaiting after",
    "copy $ pnpm dev\nready\nwaiting",
    "copy $ pnpm dev\nready\nwaiting",
  ])
})

test("a closed log drops what comes after", async () => {
  const store = desktop()
  const log = new RunLog(store.client, frames().schedule)
  log.push("kept\n")
  log.close()
  log.push("dropped\n")
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(store.text(), "")
  assert.deepEqual(store.calls, [`close ${log.id}`])
})

const page = (index: number) =>
  Array.from({ length: runLogPageLines }, (_, line) => `${index}.${line}`)

test("a window scrolled away holds at most five pages, its far end goes first", () => {
  const snapshot: RunLogSnapshot = {
    first: 8,
    pages: [page(8), page(9), page(10)],
    tail: "writing",
  }
  let window = heldWindow(snapshot)
  assert.equal(pageBelow(window, snapshot), undefined)
  window = windowWithPageAbove(window, page(7))
  window = windowWithPageAbove(window, page(6))
  assert.equal(window.tail, "writing")
  window = windowWithPageAbove(window, page(5))
  assert.equal(window.first, 5)
  assert.deepEqual(window.pages, [page(5), page(6), page(7), page(8), page(9)])
  assert.equal(window.tail, undefined)
  // Page 10 is still with the log: at the bottom, the panel follows it.
  assert.equal(pageBelow(window, snapshot), undefined)
  window = windowWithPageAbove(window, page(4))
  window = windowWithPageAbove(window, page(3))
  assert.equal(pageBelow(window, snapshot), undefined)
  // Once the log keeps later pages only, page 8 is read back.
  const later = { first: 12, pages: [page(12)], tail: "" }
  assert.equal(pageBelow(window, later), 8)
  window = windowWithPageBelow(window, page(8))
  assert.equal(window.first, 4)
  assert.deepEqual(window.pages, [page(4), page(5), page(6), page(7), page(8)])
  // At the very top: the first pages.
  assert.equal(firstPagesLines, 5 * runLogPageLines)
  assert.deepEqual(firstWindow([0, 1, 2].flatMap(page)), {
    first: 0,
    pages: [page(0), page(1), page(2)],
  })
})

test("by default, panels hear of new output at the next frame", () => {
  const callbacks: (() => void)[] = []
  const frame = globalThis.requestAnimationFrame
  // As the browser's: called on its own, never as a method.
  globalThis.requestAnimationFrame = function (this: unknown, callback) {
    assert.ok(this === undefined || this === globalThis, "Illegal invocation")
    callbacks.push(() => callback(0))
    return callbacks.length
  }
  try {
    const log = new RunLog(desktop().client)
    let heard = 0
    log.subscribe(() => (heard += 1))
    log.push("ready\n")
    callbacks.splice(0).forEach((callback) => callback())
    assert.equal(heard, 1)
    log.close()
  } finally {
    globalThis.requestAnimationFrame = frame
  }
})
