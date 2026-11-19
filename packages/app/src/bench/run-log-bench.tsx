// The run log bench (packages/desktop/scripts/run-log-bench.mjs): the
// project runner and its logs panel, as a story's preview shows them, fed
// with terminal output through a stand-in terminal. For a log already as
// long as asked, it measures what each new chunk costs: the characters
// handed to string scans, the React commits and their time, the characters
// written into the DOM and the time until the page is laid out again; then
// what the page holds once garbage collected. Its check scrolls up to the
// first line, selects all of the log to copy it, then scrolls back to the
// end, comparing what the panel shows with terminalText of all the output.
import type { ProjectRunConfiguration } from "@blame/agent-runtime"
import * as React from "react"
import { createRoot } from "react-dom/client"

import "../index.css"
import { runLogEvents, type RunLogStream } from "@/bench/run-log-streams"
import { useProjectRunner } from "@/components/backlog/board/use-project-runner"
import { ProjectRunLogPanel } from "@/components/backlog/drawer/preview-run-logs"
import {
  PlatformContext,
  type Platform,
  type TerminalClient,
  type TerminalEvent,
} from "@/context/platform"
import type { RunLogsClient } from "@/context/platform-run-logs"
import { terminalText } from "@/lib/terminal-text"

type BenchRun = { measured: number; size: number; stream: RunLogStream }
type BenchCheck = { size: number; stream: RunLogStream }

declare global {
  interface Window {
    // The desktop's run log store, in the bench's main process.
    benchRunLogs?: RunLogsClient
    gc?: () => void
    runLogBench?: {
      run(input: BenchRun): Promise<Record<string, number>>
      // The view at the first line, all of it selected.
      scrollToTop(input: BenchCheck): Promise<Record<string, unknown>>
      // What copying all of it should give.
      expectedText(): string
      // The view at the end, following new output again.
      scrollToEnd(): Promise<Record<string, unknown>>
    }
  }
}

document.documentElement.classList.add("light")

// The characters each string scan is handed: what formatting the logs
// reads, whatever does it. Patched methods only count, then do their work.
const counters = {
  commitMs: 0,
  commits: 0,
  consumerRenders: 0,
  domChars: 0,
  scanned: 0,
}
for (const name of [
  "includes",
  "indexOf",
  "lastIndexOf",
  "match",
  "matchAll",
  "replace",
  "replaceAll",
  "search",
  "split",
] as const) {
  const original = String.prototype[name] as (...args: unknown[]) => unknown
  Object.defineProperty(String.prototype, name, {
    configurable: true,
    value(this: string, ...args: unknown[]) {
      counters.scanned += this.length
      return original.apply(this, args)
    },
    writable: true,
  })
}
const originalTest = RegExp.prototype.test
RegExp.prototype.test = function (this: RegExp, input: string) {
  counters.scanned += String(input).length
  return originalTest.call(this, input)
}

const projectPath = "/bench/project"
const configuration: ProjectRunConfiguration = {
  category: "web",
  command: "pnpm dev",
  cwd: ".",
  default: true,
  id: "app",
  name: "App",
  scopes: [],
  services: [],
}

// Stands for the terminal of the desktop: the bench writes its output.
function benchTerminal() {
  let listener: ((event: TerminalEvent) => void) | undefined
  const terminal: TerminalClient = {
    onEvent: (_id, callback) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    resize: async () => true,
    start: async ({ cwd }) => ({ cwd, id: "bench" }),
    stop: async () => true,
    write: async () => true,
  }
  return {
    emit: (data: string) => listener?.({ data, id: "bench", type: "stdout" }),
    ready: () => Boolean(listener),
    terminal,
  }
}

const RunnerContext = React.createContext<unknown>(undefined)

// What else reads the shared runner, as the project's controls do: each of
// its renders counts.
const RunnerConsumer = React.memo(function RunnerConsumer() {
  const runner = React.useContext(RunnerContext)
  React.useEffect(() => {
    counters.consumerRenders += 1
  })
  return <span hidden>{runner ? "runner" : ""}</span>
})

function BenchRunner() {
  const runner = useProjectRunner([configuration], projectPath)
  const started = React.useRef(false)
  const { start } = runner
  React.useEffect(() => {
    if (started.current) return
    started.current = true
    start(configuration.id)
  }, [start])
  const session = runner.sessionFor(configuration.id)
  return (
    <RunnerContext.Provider value={runner}>
      <RunnerConsumer />
      <div className="h-[640px] w-[960px]">
        <ProjectRunLogPanel
          logs={{
            log: session?.log,
            empty: { title: "No output yet" },
            items: [
              {
                id: configuration.id,
                label: configuration.name,
                status: session?.status,
              },
            ],
            selected: configuration.id,
            onSelect: () => undefined,
          }}
        />
      </div>
    </RunnerContext.Provider>
  )
}

function Bench({ platform }: { platform: Platform }) {
  return (
    <PlatformContext.Provider value={platform}>
      <React.Profiler
        id="tree"
        onRender={(_id, _phase, actualDuration) => {
          counters.commits += 1
          counters.commitMs += actualDuration
        }}
      >
        <BenchRunner />
      </React.Profiler>
    </PlatformContext.Provider>
  )
}

const container = document.getElementById("root")!
const root = createRoot(container)
let scenario = 0

new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === "characterData")
      counters.domChars += (record.target as Text).data.length
    for (const node of record.addedNodes)
      counters.domChars += node.textContent?.length ?? 0
  }
}).observe(container, { characterData: true, childList: true, subtree: true })

// A runner started in a new tree, its log already as long as asked.
async function mountWithLog(
  stream: RunLogStream,
  size: number,
  keepOutput: boolean
) {
  scenario += 1
  const bench = benchTerminal()
  root.render(
    <Bench
      key={scenario}
      platform={{ runLogs: window.benchRunLogs, terminal: bench.terminal }}
    />
  )
  while (!bench.ready()) await frame()
  const events = runLogEvents(stream, 7)
  // In large chunks.
  let written = 0
  let batch = ""
  let output = `$ cd ${projectPath}\n$ ${configuration.command}\n`
  while (written < size) {
    const event = events.next().value as string
    batch += event
    written += event.length
    if (batch.length < 65_536 && written < size) continue
    bench.emit(batch)
    if (keepOutput) output += batch
    batch = ""
    await frame()
    await frame()
  }
  return { bench, events, output, written }
}

let checked: Awaited<ReturnType<typeof mountWithLog>> | undefined

window.runLogBench = {
  async run({ measured, size, stream }) {
    const { bench, events, written } = await mountWithLog(stream, size, false)
    const heapBefore = heapAfterCollection()
    Object.assign(counters, {
      commitMs: 0,
      commits: 0,
      consumerRenders: 0,
      domChars: 0,
      scanned: 0,
    })
    const layoutMs: number[] = []
    let chunkChars = 0
    for (let index = 0; index < measured; index += 1) {
      const event = events.next().value as string
      chunkChars += event.length
      const startedAt = performance.now()
      bench.emit(event)
      await frame()
      void container.offsetHeight
      layoutMs.push(performance.now() - startedAt)
      await frame()
    }
    const result = {
      chunkChars: chunkChars / measured,
      commitMsPerChunk: counters.commitMs / measured,
      commitsPerChunk: counters.commits / measured,
      consumerRendersPerChunk: counters.consumerRenders / measured,
      domCharsPerChunk: counters.domChars / measured,
      domTextChars: container.textContent?.length ?? 0,
      heapBefore,
      heapAfter: heapAfterCollection(),
      layoutMsMedian: median(layoutMs),
      logChars: written,
      scannedPerChunk: counters.scanned / measured,
    }
    root.render(null)
    await frame()
    return result
  },

  async scrollToTop({ size, stream }) {
    checked = await mountWithLog(stream, size, true)
    const expected = terminalText(checked.output)
    const log = container.querySelector("pre")!
    const startedAt = performance.now()
    let steps = 0
    let shown = selectAll(log)
    for (; steps < 3_000; steps += 1) {
      if (log.scrollTop === 0 && shown && expected.startsWith(shown)) break
      log.scrollTop = 0
      await frame()
      await frame()
      shown = selectAll(log)
    }
    return {
      expectedLines: expected.split("\n").length,
      shownAtTop: expected.startsWith(shown) && log.scrollTop === 0,
      msToTop: Math.round(performance.now() - startedAt),
      shownLines: shown.split("\n").length,
      stepsToTop: steps,
    }
  },

  expectedText: () => copiedText(terminalText(checked?.output ?? "")),

  async scrollToEnd() {
    const expected = copiedText(terminalText(checked?.output ?? ""))
    const log = container.querySelector("pre")!
    const atBottom = () =>
      log.scrollHeight - log.scrollTop - log.clientHeight <= 1
    // Down a screen at a time: the pages below are read back as they come.
    let continuous = true
    for (let index = 0; index < 60; index += 1) {
      log.scrollTop += log.clientHeight
      await frame()
      await frame()
      if (!expected.includes(selectAll(log))) continuous = false
    }
    const scrolledDownChars = expected.indexOf(selectAll(log))
    // Then to the very bottom: the end.
    let steps = 0
    for (; steps < 100; steps += 1) {
      if (atBottom() && expected.endsWith(selectAll(log))) break
      log.scrollTop = log.scrollHeight
      await frame()
      await frame()
    }
    const shownAtEnd = expected.endsWith(selectAll(log))
    checked?.bench.emit("one more line\n")
    for (let index = 0; index < 4; index += 1) await frame()
    const followsAgain = selectAll(log).endsWith("one more line") && atBottom()
    getSelection()?.removeAllRanges()
    root.render(null)
    await frame()
    return {
      continuous,
      followsAgain,
      scrolledDownChars,
      shownAtEnd,
      stepsToEnd: steps,
    }
  },
}

// A browser copying text that ends a selection leaves out its last newline.
function copiedText(text: string) {
  return text.replace(/\n$/, "")
}

// What the browser copies of the log, all of it selected.
function selectAll(log: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(log)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection.toString()
}

function heapAfterCollection() {
  window.gc?.()
  return (
    (performance as Performance & { memory?: { usedJSHeapSize: number } })
      .memory?.usedJSHeapSize ?? 0
  )
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}
