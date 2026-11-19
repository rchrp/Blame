import type { RunLogsClient } from "../../../context/platform-run-logs.ts"
import { TerminalTextStream } from "../../../lib/terminal-text.ts"

// A run's output as its logs panel shows it: each chunk formatted once, the
// last lines kept here in pages, and every line sent to the desktop, which
// keeps them on disk for the panel to read back the ones scrolled up to.
// Page n holds lines n * runLogPageLines onwards.
export const runLogPageLines = 100
const keptPages = 5
// What a panel scrolled away from the end holds at most.
const heldPages = 5
// Lines reach the desktop in batches.
const sendDelayMs = 100

export type RunLogSnapshot = {
  // The page of pages[0].
  first: number
  pages: readonly (readonly string[])[]
  // The line being written.
  tail: string
}

const emptySnapshot: RunLogSnapshot = { first: 0, pages: [], tail: "" }

export class RunLog {
  readonly id = crypto.randomUUID()
  private readonly client: RunLogsClient
  // Notifies the panels once per frame, whatever the chunks.
  private readonly schedule: (callback: () => void) => void
  private readonly stream = new TerminalTextStream()
  private first = 0
  private pages: (readonly string[])[] = []
  private current = emptySnapshot
  private changed = false
  private unsent = ""
  private sendTimer?: ReturnType<typeof setTimeout>
  private readonly listeners = new Set<() => void>()
  private notifying = false
  private closed = false

  constructor(
    client: RunLogsClient,
    schedule: (callback: () => void) => void = (callback) =>
      requestAnimationFrame(callback)
  ) {
    this.client = client
    this.schedule = schedule
  }

  push(output: string) {
    if (this.closed) return
    const lines = this.stream.push(output)
    if (lines.length) this.addLines(lines)
    this.changed = true
    if (this.listeners.size && !this.notifying) {
      this.notifying = true
      this.schedule(() => {
        this.notifying = false
        for (const listener of this.listeners) listener()
      })
    }
  }

  snapshot = () => {
    if (this.changed) {
      this.current = {
        first: this.first,
        pages: this.pages,
        tail: this.stream.tail,
      }
      this.changed = false
    }
    return this.current
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  read(from: number, to: number) {
    this.send()
    return this.client.read(this.id, from, to)
  }

  // The whole output between before and after. Ending the selection, it
  // leaves out its last newline, as a browser copying it would.
  copy(before: string, after: string, endsSelection: boolean) {
    this.send()
    const tail = this.stream.tail
    return this.client.copy(
      this.id,
      before,
      `${tail}${after}`,
      endsSelection && !tail
    )
  }

  // The end of what the panel shows.
  recentText(characters: number) {
    let text = this.stream.tail
    for (let page = this.pages.length - 1; page >= 0; page -= 1) {
      text = `${pageText(this.pages[page]!)}${text}`
      if (text.length >= characters) break
    }
    return text.slice(-characters)
  }

  close() {
    this.closed = true
    clearTimeout(this.sendTimer)
    this.listeners.clear()
    this.client.close(this.id)
  }

  private addLines(lines: string[]) {
    for (const line of lines) this.unsent += `${line}\n`
    this.sendTimer ??= setTimeout(() => this.send(), sendDelayMs)
    const pages = [...this.pages]
    for (let index = 0; index < lines.length;) {
      const last = pages.at(-1)
      const page =
        last && last.length < runLogPageLines ? [...last] : ([] as string[])
      if (page.length) pages[pages.length - 1] = page
      else pages.push(page)
      const end = index + runLogPageLines - page.length
      page.push(...lines.slice(index, end))
      index = end
    }
    const dropped = Math.max(0, pages.length - keptPages)
    this.first += dropped
    this.pages = pages.slice(dropped)
  }

  private send() {
    clearTimeout(this.sendTimer)
    this.sendTimer = undefined
    if (!this.unsent) return
    this.client.append(this.id, this.unsent)
    this.unsent = ""
  }
}

export function pageText(lines: readonly string[]) {
  let text = ""
  for (const line of lines) text += `${line}\n`
  return text
}

export function runLogEmpty(snapshot: RunLogSnapshot) {
  return !snapshot.pages.length && !snapshot.tail
}

// What a panel shows of a run log: the snapshot while it follows the end;
// once scrolled away, the pages it held then, with the line being written
// at that moment, and those it read back above or below them since.
export type RunLogWindow = {
  first: number
  pages: readonly (readonly string[])[]
  // Left out once the window no longer reaches the end it held.
  tail?: string
}

export function heldWindow(snapshot: RunLogSnapshot): RunLogWindow {
  return { ...snapshot }
}

// The top of the scroll bar is the first line: the first pages, read back
// in one go.
export const firstPagesLines = heldPages * runLogPageLines

export function firstWindow(lines: string[]): RunLogWindow {
  const pages: string[][] = []
  for (let at = 0; at < lines.length; at += runLogPageLines)
    pages.push(lines.slice(at, at + runLogPageLines))
  return { first: 0, pages }
}

// With the page above it, read back: the pages at the bottom go first.
export function windowWithPageAbove(
  window: RunLogWindow,
  page: readonly string[]
): RunLogWindow {
  const pages = [page, ...window.pages]
  if (pages.length <= heldPages)
    return { ...window, first: window.first - 1, pages }
  return { first: window.first - 1, pages: pages.slice(0, heldPages) }
}

// With the page below it, read back: the pages at the top go first.
export function windowWithPageBelow(
  window: RunLogWindow,
  page: readonly string[]
): RunLogWindow {
  const pages = [...window.pages, page]
  const dropped = Math.max(0, pages.length - heldPages)
  return { first: window.first + dropped, pages: pages.slice(dropped) }
}

// The page below the window, unless the window ends where the snapshot
// does: scrolling to its bottom then follows the end again.
export function pageBelow(window: RunLogWindow, snapshot: RunLogSnapshot) {
  const next = window.first + window.pages.length
  return window.tail === undefined && next < snapshot.first ? next : undefined
}

export function windowText(window: RunLogWindow) {
  let text = ""
  for (const page of window.pages) text += pageText(page)
  return text + (window.tail ?? "")
}
