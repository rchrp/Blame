import * as React from "react"
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  GlobeIcon,
  SearchIcon,
} from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { usePlatform } from "@/context/platform"
import { cn } from "@/lib/utils"
import type { WebSource } from "@blame/agent-runtime/web-research"
import { citationIds, type ResearchSource } from "./web-research-data"
import { useWebResearch } from "./web-research-context"

export function SourceFavicon({
  source,
  className,
}: {
  source: WebSource
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)
  // First-party icons only; no query or source list is sent to a favicon aggregator.
  const url = new URL(source.url)
  const hostname = url.hostname
  const publicHost =
    hostname.includes(".") &&
    !/^[\d.]+$/.test(hostname) &&
    !hostname.includes(":") &&
    !/\.(?:local|internal|localhost|home|lan)$/.test(hostname)
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-background",
        className,
        !failed && publicHost && "bg-white"
      )}
    >
      {!failed && publicHost ? (
        <img
          src={`${url.origin}/favicon.ico`}
          alt=""
          className="size-3.5 object-contain"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <GlobeIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  )
}

export function SourceStack({ sources }: { sources: WebSource[] }) {
  const unique = [
    ...new Map(sources.map((source) => [source.domain, source])).values(),
  ].slice(0, 4)
  return (
    <span
      className="isolate inline-flex shrink-0 items-center -space-x-1.5"
      aria-hidden="true"
    >
      {unique.map((source, index) => (
        <SourceFavicon
          key={source.domain}
          source={source}
          className={cn(
            index === 0
              ? "z-40"
              : index === 1
                ? "z-30"
                : index === 2
                  ? "z-20"
                  : "z-10"
          )}
        />
      ))}
    </span>
  )
}

function SourceLink({
  source,
  children,
  className,
}: {
  source: WebSource
  children: React.ReactNode
  className?: string
}) {
  const platform = usePlatform()
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={(event) => {
        if (platform.openExternalLink) {
          event.preventDefault()
          platform.openExternalLink(source.url)
        }
      }}
    >
      {children}
    </a>
  )
}

function SourceDetail({ source }: { source: ResearchSource }) {
  return (
    <div className="grid min-w-0 gap-3 p-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <SourceFavicon source={source} />
        <span className="truncate">{source.domain}</span>
      </div>
      <SourceLink
        source={source}
        className="group flex items-start gap-2 rounded text-sm leading-5 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {source.title}
        </span>
        <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </SourceLink>
      {source.snippet ? (
        <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">
          {source.snippet}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {source.consulted
            ? source.partial
              ? "Partially read"
              : "Page consulted"
            : "Search excerpt"}
        </span>
        {source.publishedAt ? (
          <span>Published {formatDate(source.publishedAt)}</span>
        ) : null}
        {source.author ? <span>{source.author}</span> : null}
      </div>
      {source.error ? (
        <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
          {source.error}
        </p>
      ) : null}
      {source.passage ? (
        <details className="border-t pt-2 text-xs">
          <summary className="cursor-pointer rounded py-1 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            View extracted text
          </summary>
          <p className="mt-2 max-h-44 overflow-auto leading-5 whitespace-pre-wrap">
            {source.passage}
          </p>
          <p className="mt-2 text-muted-foreground">
            Beginning of the extracted page
          </p>
        </details>
      ) : null}
      <span className="text-[11px] text-muted-foreground">
        Retrieved {formatDate(source.retrievedAt)}
      </span>
    </div>
  )
}

export function SourceCitation({ id, label }: { id: string; label: string }) {
  const { sources, loading } = useWebResearch()
  const source = sources.find((entry) => entry.id === id)
  if (!source)
    return (
      <span
        className="inline text-xs text-muted-foreground"
        title={
          loading
            ? "Loading source"
            : "This source is not available in the conversation"
        }
      >
        {label} · {loading ? "loading" : "source unavailable"}
      </span>
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Source: ${source.title}`}
          className="mx-0.5 inline-flex max-w-52 translate-y-0.5 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 align-baseline text-[11px] leading-4 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SourceFavicon
            source={source}
            className="size-4 bg-transparent ring-0"
          />
          <span className="truncate">
            {source.siteName || source.domain.replace(/^www\./, "")}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        collisionPadding={12}
        align="start"
      >
        <SourceDetail source={source} />
      </PopoverContent>
    </Popover>
  )
}

export function SourcesSummary({
  runId,
  markdown,
}: {
  runId: string
  markdown: string
}) {
  const { sources, loading } = useWebResearch()
  const cited = citationIds(markdown)
  const relevant = sources
    .filter((source) => source.runIds.includes(runId) || cited.has(source.id))
    .map((source) => ({ ...source, cited: cited.has(source.id) }))
  const [filter, setFilter] = React.useState<
    "all" | "found" | "read" | "cited"
  >("all")
  if (!relevant.length)
    return loading ? (
      <span role="status" className="text-xs text-muted-foreground">
        Loading sources…
      </span>
    ) : null
  const visible = relevant.filter(
    (source) =>
      filter === "all" ||
      (filter === "found"
        ? source.found
        : filter === "read"
          ? source.consulted
          : source.cited)
  )
  const counts = {
    all: relevant.length,
    found: relevant.filter((source) => source.found).length,
    read: relevant.filter((source) => source.consulted).length,
    cited: relevant.filter((source) => source.cited).length,
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex w-fit items-center gap-2 rounded-full border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`View ${relevant.length} sources`}
        >
          <SourceStack sources={relevant} />
          <span>
            {relevant.length} {relevant.length === 1 ? "source" : "sources"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="max-h-[min(38rem,var(--radix-popover-content-available-height))] w-[26rem] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
      >
        <div className="shrink-0 px-4 pt-4 pb-3">
          <h3 className="text-sm font-semibold">Sources</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {counts.read} consulted · {counts.cited} cited in this response
          </p>
        </div>
        <div
          role="group"
          aria-label="Filter sources"
          className="flex shrink-0 gap-1 border-b px-3 pb-3"
        >
          {(["all", "found", "read", "cited"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                filter === key
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}
            >
              {key === "all"
                ? "All"
                : key === "found"
                  ? "Found"
                  : key === "read"
                    ? "Consulted"
                    : "Cited"}{" "}
              <span className="ml-1 tabular-nums">{counts[key]}</span>
            </button>
          ))}
        </div>
        <div className="max-h-[min(28rem,60vh)] min-h-0 overflow-y-auto overscroll-contain px-4">
          {visible.length ? (
            visible.map((source) => (
              <div key={source.id} className="border-b py-3 last:border-0">
                <SourceDetail source={source} />
              </div>
            ))
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {filter === "cited"
                ? "No sources cited in this response."
                : filter === "found"
                  ? "No search results in this response."
                  : "No pages consulted yet."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function WebSourcesBody({
  sources,
  reading = false,
}: {
  sources: WebSource[]
  reading?: boolean
}) {
  const { sources: known } = useWebResearch()
  return (
    <div className="divide-y rounded-lg border px-3">
      {sources.map((source) => {
        const entry = known.find((item) => item.id === source.id)
        return (
          <div key={source.id} className="flex items-start gap-2.5 py-3">
            <SourceFavicon source={source} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <SourceLink
                source={source}
                className="block truncate rounded text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {source.title}
              </SourceLink>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{source.domain}</span>
                {entry?.consulted || reading ? (
                  <span className="inline-flex items-center gap-1">
                    <BookOpenIcon className="size-3" />
                    {entry?.partial ? "Partially read" : "Consulted"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <SearchIcon className="size-3" />
                    Found
                  </span>
                )}
                {entry?.cited ? <span>Cited</span> : null}
              </div>
              {source.snippet ? (
                <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {source.snippet}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "date unavailable"
}
