import * as React from "react"

import {
  firstPagesLines,
  firstWindow,
  heldWindow,
  pageBelow,
  pageText,
  runLogPageLines,
  windowText,
  windowWithPageAbove,
  windowWithPageBelow,
  type RunLog,
  type RunLogSnapshot,
  type RunLogWindow,
} from "@/components/backlog/board/run-log"
import { useLatestCallback } from "@/lib/use-latest-callback"

const noOutput: RunLogSnapshot = { first: 0, pages: [], tail: "" }
const subscribeNowhere = () => () => {}
const noOutputSnapshot = () => noOutput

export function useRunLogSnapshot(log?: RunLog) {
  return React.useSyncExternalStore(
    log?.subscribe ?? subscribeNowhere,
    log?.snapshot ?? noOutputSnapshot
  )
}

// A run log's text, scrolling: one block per page, so that a chunk lays
// out only the page it lands on. It follows the end until scrolled away;
// then it holds what it showed and reads back the pages above or below as
// they come near. Scrolled to the very top, it shows the first line; to
// the very bottom, it follows the end again. Copying all of it copies the
// whole output.
export function RunLogText({
  className,
  label,
  log,
  snapshot,
}: {
  className: string
  label?: string
  log: RunLog
  snapshot: RunLogSnapshot
}) {
  const ref = React.useRef<HTMLPreElement>(null)
  const [held, setHeld] = React.useState<RunLogWindow>()
  const reading = React.useRef(false)
  const shown = held ?? snapshot

  React.useLayoutEffect(() => {
    const element = ref.current
    if (element && !held) element.scrollTop = element.scrollHeight
  }, [held, snapshot])

  const read = (
    from: number,
    to: number,
    place: (window: RunLogWindow, lines: string[]) => RunLogWindow
  ) => {
    if (reading.current) return
    reading.current = true
    void log
      .read(from, to)
      .then(
        (lines) => setHeld((current) => current && place(current, lines)),
        () => undefined
      )
      .finally(() => {
        reading.current = false
      })
  }

  const readNearEdge = useLatestCallback(() => {
    const element = ref.current
    if (!element || !held) return
    const below =
      element.scrollHeight - element.scrollTop - element.clientHeight
    const next = pageBelow(held, snapshot)
    const page = (index: number) =>
      [index * runLogPageLines, (index + 1) * runLogPageLines] as const
    if (held.first > 0 && element.scrollTop === 0)
      read(0, firstPagesLines, (_, lines) => firstWindow(lines))
    else if (held.first > 0 && element.scrollTop < element.clientHeight)
      read(...page(held.first - 1), windowWithPageAbove)
    else if (next !== undefined && below < element.clientHeight)
      read(...page(next), windowWithPageBelow)
  })

  const onScroll = useLatestCallback(() => {
    const element = ref.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= 1
    // The bottom of the scroll bar is the last line, as its top is the
    // first.
    if (!held) {
      if (!atBottom) setHeld(heldWindow(snapshot))
    } else if (atBottom) {
      setHeld(undefined)
    } else {
      readNearEdge()
    }
  })

  // Once pages are read back, the view looks again at the next frame, as a
  // scroll would: a scroll the browser made, or one with nothing left to
  // move at the top or bottom, sends no event.
  React.useEffect(() => {
    if (!held) return
    const frame = requestAnimationFrame(onScroll)
    return () => cancelAnimationFrame(frame)
  }, [held, onScroll])

  const copy = useLatestCallback((event: ClipboardEvent) => {
    const element = ref.current
    const selection = document.getSelection()
    // All of the output is shown: the browser copies it.
    if (!element || !selection?.rangeCount || (!held && snapshot.first === 0))
      return
    const all = document.createRange()
    all.selectNodeContents(element)
    const range = selection.getRangeAt(0)
    if (
      range.compareBoundaryPoints(Range.START_TO_START, all) > 0 ||
      range.compareBoundaryPoints(Range.END_TO_END, all) < 0
    )
      return
    // Ending the selection, the log's last newline is left out.
    const text = selection.toString()
    const shownText = windowText(shown)
    const ending =
      shownText.endsWith("\n") && text.endsWith(shownText.slice(0, -1))
    const copied = ending ? shownText.slice(0, -1) : shownText
    const at = ending ? text.length - copied.length : text.indexOf(copied)
    if (at === -1) return
    event.preventDefault()
    void log.copy(text.slice(0, at), text.slice(at + copied.length), ending)
  })
  React.useEffect(() => {
    document.addEventListener("copy", copy)
    return () => document.removeEventListener("copy", copy)
  }, [copy])

  return (
    <pre aria-label={label} className={className} ref={ref} onScroll={onScroll}>
      {shown.pages.map((lines, index) => (
        <RunLogPage key={shown.first + index} lines={lines} />
      ))}
      {shown.tail ? <span className="block">{shown.tail}</span> : null}
    </pre>
  )
}

const RunLogPage = React.memo(function RunLogPage({
  lines,
}: {
  lines: readonly string[]
}) {
  return <span className="block">{pageText(lines)}</span>
})
