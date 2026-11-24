// The idle GPU bench (packages/desktop/scripts/idle-gpu-bench.mjs): the
// board, the story drawer and the agent's conversation, drawn with the app's
// own components and effects from fixed stories, so their GPU and compositor
// cost can be measured without a runtime, an account or an agent.
import * as React from "react"
import { createRoot } from "react-dom/client"

import "../index.css"
import { ReadOnlyUserStoryCard } from "@/components/backlog/board/user-story-card"
import type {
  BacklogColumnId,
  UserStory,
} from "@/components/backlog/data/backlog-data"
import {
  PreviewAmbilightCloud,
  previewAmbilightShadow,
  useNativePreviewAmbilight,
} from "@/components/backlog/drawer/preview-ambilight"
import { PlanProgressLine } from "@/components/chat/plan/plan-progress-line"
import {
  KanbanBoard,
  KanbanColumn,
  KanbanColumnHeader,
} from "@/components/shared/kanban-board"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import type { PreviewBrowserClient } from "@/context/platform"
import { useAnimatedBorderEffect } from "@/hooks/use-animated-border-effect"

type BenchState = "blank" | "board" | "drawer" | "agent" | "waiting"

type BenchPreview = {
  capture(): Promise<string | null>
  setBounds(bounds: {
    height: number
    width: number
    x: number
    y: number
  }): void
}

declare global {
  interface Window {
    benchPreview?: BenchPreview
    idleGpuBenchReady?: boolean
  }
}

const params = new URLSearchParams(location.search)
const state = (params.get("state") ?? "board") as BenchState
document.documentElement.classList.add(params.get("theme") ?? "light")

const columns: {
  color: string
  count: number
  id: BacklogColumnId
  title: string
}[] = [
  { color: "border-slate-400", count: 6, id: "backlog", title: "Backlog" },
  { color: "border-violet-400", count: 3, id: "ready", title: "Ready" },
  { color: "border-blue-500", count: 3, id: "in-progress", title: "Doing" },
  { color: "border-amber-500", count: 10, id: "in-review", title: "Review" },
  { color: "border-emerald-500", count: 8, id: "done", title: "Done" },
  { color: "border-zinc-400", count: 2, id: "discarded", title: "Discarded" },
]

const titles = [
  "Let people export their invoices as PDF",
  "Show the team's activity on the dashboard",
  "Remember the last filter on the orders page",
  "Add a dark theme to the settings",
  "Send a weekly summary email",
  "Sort products by popularity",
  "Warn before leaving an unsaved form",
  "Paginate the customer list",
]

let storyNumber = 0
function benchStory(status: BacklogColumnId): UserStory {
  storyNumber += 1
  return {
    createdAt: "2026-11-18T10:00:00.000Z",
    id: `story-${storyNumber}`,
    owner: "Product",
    priority: "Medium",
    projectId: "bench",
    status,
    storyNumber,
    summary: "As a customer, I want this so that it works.",
    title: titles[storyNumber % titles.length] ?? "A story",
  }
}

const board = columns.map((column) => ({
  ...column,
  stories: Array.from({ length: column.count }, () => benchStory(column.id)),
}))

function BenchApp() {
  React.useEffect(() => {
    window.idleGpuBenchReady = true
  }, [])
  if (state === "blank") return <div className="h-svh" />
  if (state === "waiting") {
    return (
      <main className="grid h-svh content-start gap-5 bg-popover p-8 text-sm">
        <BenchActivity label="Thinking" />
        <BenchActivity label="Working" />
        <PlanProgressLine
          progress={{
            done: 1,
            abandoned: 0,
            total: 3,
            open: 2,
            finished: false,
            current: "Run checks",
          }}
          step
        />
      </main>
    )
  }
  return (
    <div
      className="flex h-svh"
      style={
        // As the app's layout (app-layout.tsx).
        {
          "--header-height": "calc(var(--spacing) * 16)",
        } as React.CSSProperties
      }
    >
      <div className="w-64 shrink-0" />
      <main className="app-page-surface relative m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-(--surface-fade-color) shadow-sm">
        <BenchHeader />
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-[calc(var(--header-height)+1.5rem)] pb-6">
          <KanbanBoard
            className="-mx-6 px-6"
            gridClassName="min-w-500 grid-cols-6"
          >
            {board.map((column) => (
              <KanbanColumn
                key={column.id}
                header={
                  <KanbanColumnHeader
                    color={column.color}
                    count={column.stories.length}
                    description="Stories in this column"
                    title={column.title}
                  />
                }
              >
                {column.stories.map((story) => (
                  <ReadOnlyUserStoryCard key={story.id} story={story} />
                ))}
              </KanbanColumn>
            ))}
          </KanbanBoard>
        </div>
      </main>
      {state === "board" ? null : <BenchDrawer />}
    </div>
  )
}

// The app header over the board (site-header.tsx).
function BenchHeader() {
  return (
    <header className="app-page-header-fade pointer-events-none absolute inset-x-0 top-0 z-20">
      <div className="relative flex h-(--header-height) items-center gap-2 pl-6">
        <h1 className="truncate text-base font-medium">Bench project</h1>
      </div>
    </header>
  )
}

// The story drawer's header over the preview or the conversation.
function BenchDrawer() {
  return (
    <Drawer direction="right" open>
      <DrawerContent
        className="story-drawer-surface overflow-hidden rounded-xl border bg-(--surface-fade-color) text-foreground outline-none data-[vaul-drawer-direction=right]:w-[min(90rem,calc(100vw-1rem))] data-[vaul-drawer-direction=right]:sm:max-w-none"
        overlayClassName="bg-black/30 dark:bg-black/50"
      >
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <DrawerHeader className="surface-fade-top absolute top-0 right-0 left-0 z-[15] gap-4 overflow-hidden px-6 pt-6 pr-14 pb-6">
            <DrawerTitle className="text-lg font-semibold">
              Let people export their invoices as PDF
            </DrawerTitle>
            <DrawerDescription>Product created this</DrawerDescription>
          </DrawerHeader>
          <div className="h-full pt-28">
            {state === "drawer" ? <BenchPreview /> : <BenchConversation />}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

const benchClient = {
  capture: () => window.benchPreview?.capture() ?? Promise.resolve(null),
  onState: () => () => {},
} as unknown as PreviewBrowserClient

// The preview tab: its toolbar and the native page, framed by the glow
// (native-preview.tsx, user-story-preview.tsx). The page itself is a native
// view the bench's main process lays over the frame.
function BenchPreview() {
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  // As in the app, sampled once the page shows (native-preview.tsx).
  const [loaded, setLoaded] = React.useState(false)
  const ambilight = useNativePreviewAmbilight(
    benchClient,
    "bench-preview",
    "bench",
    loaded
  )
  React.useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const place = () => {
      const { height, left, top, width } = surface.getBoundingClientRect()
      window.benchPreview?.setBounds({ height, width, x: left, y: top })
    }
    const observer = new ResizeObserver(place)
    observer.observe(surface)
    // The drawer slides in: follow it until it settles.
    const timers = [100, 400, 800, 1500].map((delay) =>
      window.setTimeout(place, delay)
    )
    timers.push(window.setTimeout(() => setLoaded(true), 1_600))
    return () => {
      observer.disconnect()
      timers.forEach(window.clearTimeout)
    }
  }, [])
  return (
    <div className="relative h-full min-h-0">
      <div className="pointer-events-auto absolute top-4 right-4 left-4 z-30 flex h-10 items-center gap-1.5">
        <span className="size-9 shrink-0 rounded-full border bg-popover shadow-sm" />
        <div className="flex h-10 min-w-0 flex-1 items-center rounded-full border bg-popover py-1 pr-1.5 pl-4 text-sm shadow-sm">
          localhost:3000/
        </div>
      </div>
      <div className="flex h-full min-h-0 flex-col px-4 pt-16 pb-4">
        <div className="relative min-h-0 flex-1">
          <PreviewAmbilightCloud ambilight={ambilight} />
          <div
            className="relative h-full overflow-hidden rounded-lg border bg-background"
            style={{ boxShadow: previewAmbilightShadow() }}
          >
            <div ref={surfaceRef} className="h-full w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

const streamWords =
  "I added the export button to the invoice page and wired it to the new PDF renderer. The renderer lays out each line item, the totals and the customer's address, then streams the file to the browser. I also covered the empty invoice and the long address cases with tests, and checked the result in the preview.".split(
    " "
  )

// An agent writing its reply (agent-conversation.tsx): the latest reply's
// animated border, activity markers and the composer's fade over the thread.
function BenchConversation() {
  // The reply keeps growing on screen: the thread does not follow it down,
  // so once it fills the screen it starts over.
  const [words, setWords] = React.useState(0)
  React.useEffect(() => {
    const timer = window.setInterval(
      () => setWords((count) => (count + 3) % 240),
      100
    )
    return () => window.clearInterval(timer)
  }, [])
  const responseRef = useAnimatedBorderEffect("agent-response")
  const paragraphs = Array.from(
    { length: Math.floor(words / 60) + 1 },
    (_, i) =>
      streamWords
        .concat(streamWords)
        .slice(0, Math.min(60, words - i * 60))
        .join(" ")
  )
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-4xl gap-10 px-10 pt-4 pb-40">
          <div className="flex min-h-10 items-center gap-2.5 py-1 text-sm text-muted-foreground">
            <BenchActivity label="Working" />
            <span>· 12 steps</span>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>Running pnpm test</span>
          </div>
          <div ref={responseRef} className="agent-response-effect min-w-0">
            <div className="grid gap-3 p-5 text-sm leading-relaxed">
              {paragraphs.map((text, index) => (
                <p key={index}>{text}</p>
              ))}
            </div>
          </div>
          <div className="px-2 py-2 text-sm">
            <BenchActivity label="Thinking" />
          </div>
        </div>
      </div>
      <div className="surface-fade-bottom pointer-events-auto absolute inset-x-0 bottom-0 px-4 pt-4 pb-4">
        <div className="relative mx-auto h-28 w-full max-w-4xl rounded-3xl border bg-background shadow-sm" />
      </div>
    </div>
  )
}

function BenchActivity({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2.5 font-medium text-foreground">
      <span className="agent-activity-mark" aria-hidden="true" />
      {label}
    </span>
  )
}

createRoot(document.getElementById("root")!).render(<BenchApp />)
