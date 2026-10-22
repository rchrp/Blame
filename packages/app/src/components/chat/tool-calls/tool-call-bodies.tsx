import * as React from "react"
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

import { ScreenshotToolCallBody } from "../screenshots/screenshot-tool-call"
import type {
  DiffFile,
  SearchHit,
  TestCounts,
  ToolCallBody,
} from "./tool-call-view"

// Expanded content of a tool call, one renderer per kind of detail.

const maxLines = 400

type OpenFile = ((path: string) => void) | undefined

export function ToolCallBodyView({
  body,
  onOpenFile,
}: {
  body: ToolCallBody
  onOpenFile?: (path: string) => void
}) {
  if (body.type === "code")
    return <CodeBody {...body} onOpenFile={onOpenFile} />
  if (body.type === "diff")
    return <DiffBody files={body.files} onOpenFile={onOpenFile} />
  if (body.type === "terminal") return <TerminalBody {...body} />
  if (body.type === "search")
    return (
      <SearchBody hits={body.hits} more={body.more} onOpenFile={onOpenFile} />
    )
  if (body.type === "files")
    return (
      <FilesBody files={body.files} more={body.more} onOpenFile={onOpenFile} />
    )
  if (body.type === "tests") return <TestsBody counts={body.counts} />
  if (body.type === "text") return <TextBody {...body} />
  if (body.type === "fields") return <FieldsBody fields={body.fields} />
  if (body.type === "list")
    return <ListBody label={body.label} items={body.items} />
  if (body.type === "screenshot")
    return (
      <ScreenshotToolCallBody
        pending={body.pending}
        screenshots={body.screenshots}
      />
    )
  return <ErrorBody message={body.message} recovery={body.recovery} />
}

function Panel({
  children,
  className,
  header,
}: {
  children: React.ReactNode
  className?: string
  header?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border bg-muted/20",
        className
      )}
    >
      {header ? (
        <div className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {header}
        </div>
      ) : null}
      {children}
    </div>
  )
}

// Copies text and confirms with a check mark for a moment.
export function CopyButton({
  className,
  label = "Copy",
  text,
}: {
  className?: string
  label?: string
  text: string
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className
      )}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? (
        <CheckIcon className="size-3 text-emerald-500" />
      ) : (
        <CopyIcon className="size-3" />
      )}
      {copied ? "Copied" : null}
    </button>
  )
}

function PathButton({
  onOpenFile,
  path,
  children,
}: {
  onOpenFile: OpenFile
  path: string
  children: React.ReactNode
}) {
  if (!onOpenFile) return <>{children}</>
  return (
    <button
      type="button"
      title={`Open ${path}`}
      className="group/path flex min-w-0 items-center gap-1 rounded text-left hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => onOpenFile(path)}
    >
      {children}
      <ExternalLinkIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/path:opacity-70" />
    </button>
  )
}

function Truncated({ hidden }: { hidden?: number | boolean }) {
  if (!hidden) return null
  return (
    <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      {typeof hidden === "number"
        ? `${hidden} more lines not shown.`
        : "Shortened preview."}
    </div>
  )
}

function CodeBody({
  label,
  onOpenFile,
  path,
  startLine,
  text,
  truncated,
}: {
  label?: string
  onOpenFile: OpenFile
  path?: string
  startLine?: number
  text: string
  truncated?: boolean
}) {
  const lines = text.replace(/\n$/u, "").split("\n")
  const shown = lines.slice(0, maxLines)
  const header = label ?? path
  return (
    <Panel
      header={
        <>
          {header ? (
            path && !label ? (
              <PathButton onOpenFile={onOpenFile} path={path}>
                <span className="truncate font-mono">{header}</span>
              </PathButton>
            ) : (
              <span className="truncate font-mono" title={path}>
                {header}
              </span>
            )
          ) : null}
          <CopyButton className="ml-auto" label="Copy code" text={text} />
        </>
      }
    >
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {shown.map((line, index) => (
              <tr key={index}>
                {startLine !== undefined ? (
                  <td className="w-px pr-3 pl-3 text-right align-top text-muted-foreground/60 tabular-nums select-none">
                    {startLine + index}
                  </td>
                ) : null}
                <td
                  className={cn(
                    "pr-3 whitespace-pre text-foreground/90",
                    startLine === undefined && "pl-3"
                  )}
                >
                  {line || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Truncated
        hidden={lines.length > maxLines ? lines.length - maxLines : truncated}
      />
    </Panel>
  )
}

function DiffBody({
  files,
  onOpenFile,
}: {
  files: DiffFile[]
  onOpenFile: OpenFile
}) {
  return (
    <div className="grid gap-2">
      {files.map((file, index) => (
        <Panel
          key={`${file.path}-${index}`}
          header={
            <>
              <PathButton onOpenFile={onOpenFile} path={file.path}>
                <span
                  className="min-w-0 truncate font-mono text-foreground/80"
                  title={file.path}
                >
                  {file.path}
                </span>
              </PathButton>
              {file.status === "added" ? <StatusTag label="New" /> : null}
              {file.status === "deleted" ? <StatusTag label="Deleted" /> : null}
              {file.note ? <span className="truncate">{file.note}</span> : null}
              <span className="ml-auto flex shrink-0 gap-2 font-mono">
                {file.additions !== undefined ? (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{file.additions}
                  </span>
                ) : null}
                {file.deletions !== undefined && file.status !== "added" ? (
                  <span className="text-red-600 dark:text-red-400">
                    −{file.deletions}
                  </span>
                ) : null}
              </span>
            </>
          }
        >
          {file.lines.length ? (
            <div className="max-h-80 overflow-auto font-mono text-xs leading-5">
              {file.lines.slice(0, maxLines).map((line, lineIndex) =>
                line.kind === "hunk" ? (
                  <div
                    key={lineIndex}
                    className="bg-muted/50 px-3 text-muted-foreground/80"
                  >
                    {line.text || "⋯"}
                  </div>
                ) : (
                  <div
                    key={lineIndex}
                    className={cn(
                      "flex whitespace-pre",
                      line.kind === "add" &&
                        "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100",
                      line.kind === "remove" &&
                        "bg-red-500/10 text-red-950 dark:text-red-100"
                    )}
                  >
                    <span
                      className={cn(
                        "w-6 shrink-0 text-center select-none",
                        line.kind === "add" &&
                          "text-emerald-600 dark:text-emerald-400",
                        line.kind === "remove" &&
                          "text-red-600 dark:text-red-400",
                        line.kind === "context" && "text-muted-foreground/40"
                      )}
                    >
                      {line.kind === "add"
                        ? "+"
                        : line.kind === "remove"
                          ? "−"
                          : " "}
                    </span>
                    <span className="pr-3">{line.text || " "}</span>
                  </div>
                )
              )}
            </div>
          ) : null}
          <Truncated
            hidden={
              file.lines.length > maxLines
                ? file.lines.length - maxLines
                : undefined
            }
          />
        </Panel>
      ))}
    </div>
  )
}

function StatusTag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium">
      {label}
    </span>
  )
}

function TerminalBody({
  command,
  cwd,
  exitCode,
  output,
  truncated,
}: {
  command?: string
  cwd?: string
  exitCode?: number
  output?: string
  truncated?: boolean
}) {
  const lines = output?.replace(/\n$/u, "").split("\n") ?? []
  const shown = lines.slice(-maxLines)
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-black/10 bg-[#0d1017] font-mono text-xs leading-5 text-[#d6deeb] dark:border-white/10">
      {command ? (
        <div className="flex gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="shrink-0 text-emerald-400 select-none">
            {cwd ? `${cwd} $` : "$"}
          </span>
          <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-white">
            {command}
          </span>
          <CopyButton
            className="text-[#7f8898] hover:bg-white/10 hover:text-white"
            label="Copy command"
            text={command}
          />
        </div>
      ) : null}
      {shown.length ? (
        <pre className="max-h-72 overflow-auto px-3 py-2 break-words whitespace-pre-wrap text-[#c3cad6]">
          {lines.length > maxLines
            ? `… ${lines.length - maxLines} earlier lines\n`
            : ""}
          {shown.join("\n")}
        </pre>
      ) : command ? (
        <div className="px-3 py-2 text-[#7f8898]">No output</div>
      ) : null}
      {exitCode !== undefined || truncated ? (
        <div className="flex items-center gap-3 border-t border-white/[0.06] px-3 py-1.5 text-[11px] text-[#7f8898]">
          {exitCode !== undefined ? (
            <span
              className={exitCode === 0 ? "text-emerald-400" : "text-red-400"}
            >
              {exitCode === 0
                ? "Exited successfully"
                : `Exited with code ${exitCode}`}
            </span>
          ) : null}
          {truncated ? <span>Shortened output</span> : null}
        </div>
      ) : null}
    </div>
  )
}

const kindLabels: Record<string, string> = {
  class: "class",
  method: "method",
  function: "fn",
  interface: "interface",
  type: "type",
  variable: "var",
  constant: "const",
  property: "prop",
  enum: "enum",
}

function SearchBody({
  hits,
  more,
  onOpenFile,
}: {
  hits: SearchHit[]
  more?: number
  onOpenFile: OpenFile
}) {
  return (
    <Panel>
      <ul className="divide-y">
        {hits.map((hit, index) => (
          <li
            key={`${hit.path}-${hit.line}-${index}`}
            className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs"
          >
            {hit.kind ? (
              <span className="w-16 shrink-0 truncate rounded bg-primary/10 px-1.5 py-px text-center text-[10px] font-medium text-primary dark:text-indigo-300">
                {kindLabels[hit.kind] ?? hit.kind}
              </span>
            ) : null}
            <span
              className="min-w-0 truncate font-mono text-foreground/90"
              title={hit.snippet}
            >
              {hit.name ?? hit.snippet ?? hit.path}
            </span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">
              <PathButton onOpenFile={onOpenFile} path={hit.path}>
                <span className="truncate" title={hit.path}>
                  {hit.path.split("/").slice(-2).join("/")}
                  {hit.line !== undefined ? `:${hit.line}` : ""}
                </span>
              </PathButton>
            </span>
          </li>
        ))}
      </ul>
      {more ? (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {more} more {more === 1 ? "result" : "results"} not shown.
        </div>
      ) : null}
    </Panel>
  )
}

function FilesBody({
  files,
  more,
  onOpenFile,
}: {
  files: { path: string; detail?: string; kind?: "file" | "directory" }[]
  more?: number
  onOpenFile: OpenFile
}) {
  return (
    <Panel>
      <ul className="max-h-72 divide-y overflow-auto">
        {files.map((file) => (
          <li
            key={file.path}
            className="flex min-w-0 items-center gap-2 px-3 py-1.5 font-mono text-xs"
          >
            {file.kind === "directory" ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {file.kind === "directory" ? (
              <span
                className="min-w-0 truncate text-foreground/90"
                title={file.path}
              >
                {file.path}
              </span>
            ) : (
              <PathButton onOpenFile={onOpenFile} path={file.path}>
                <span className="min-w-0 truncate text-foreground/90">
                  {file.path}
                </span>
              </PathButton>
            )}
            {file.detail ? (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {file.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {more ? (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {more} more not shown.
        </div>
      ) : null}
    </Panel>
  )
}

function TestsBody({ counts }: { counts: TestCounts }) {
  const total =
    counts.total ??
    (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0)
  const segments = [
    {
      value: counts.passed ?? 0,
      label: "passed",
      className: "bg-emerald-500",
      text: "text-emerald-600 dark:text-emerald-400",
    },
    {
      value: counts.failed ?? 0,
      label: "failed",
      className: "bg-red-500",
      text: "text-red-600 dark:text-red-400",
    },
    {
      value: counts.skipped ?? 0,
      label: "skipped",
      className: "bg-amber-400",
      text: "text-amber-600 dark:text-amber-400",
    },
  ]
  return (
    <Panel className="px-3 py-2.5">
      <div className="flex items-baseline gap-4 text-xs">
        {segments.map((segment) =>
          segment.value || segment.label === "passed" ? (
            <span key={segment.label} className="flex items-baseline gap-1">
              <span
                className={cn(
                  "text-base font-semibold tabular-nums",
                  segment.text
                )}
              >
                {segment.value}
              </span>
              <span className="text-muted-foreground">{segment.label}</span>
            </span>
          ) : null
        )}
        <span className="ml-auto text-muted-foreground">{total} total</span>
      </div>
      {total > 0 ? (
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
          {segments.map((segment) =>
            segment.value ? (
              <span
                key={segment.label}
                className={segment.className}
                style={{ width: `${(segment.value / total) * 100}%` }}
              />
            ) : null
          )}
        </div>
      ) : null}
    </Panel>
  )
}

function TextBody({
  label,
  text,
  truncated,
}: {
  label?: string
  text: string
  truncated?: boolean
}) {
  return (
    <div className="grid gap-1">
      {label ? (
        <span className="text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div className="max-h-72 overflow-auto rounded-lg bg-muted/30 px-3 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
        {text}
        {truncated ? <span className="text-muted-foreground"> …</span> : null}
      </div>
    </div>
  )
}

function FieldsBody({
  fields,
}: {
  fields: { label: string; value: string; mono?: boolean }[]
}) {
  return (
    <dl className="grid gap-1.5 rounded-lg bg-muted/30 px-3 py-2 text-xs">
      {fields.map((field) => (
        <div
          key={field.label}
          className="grid min-w-0 gap-2 sm:grid-cols-[8rem_1fr]"
        >
          <dt className="truncate text-muted-foreground">{field.label}</dt>
          <dd
            className={cn(
              "min-w-0 break-words whitespace-pre-wrap text-foreground/90",
              field.mono && "font-mono"
            )}
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ListBody({ label, items }: { label?: string; items: string[] }) {
  return (
    <div className="grid gap-1">
      {label ? (
        <span className="text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      ) : null}
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="rounded-md bg-muted/50 px-2 py-0.5 font-mono text-xs text-foreground/85"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ErrorBody({
  message,
  recovery,
}: {
  message: string
  recovery?: string
}) {
  return (
    <div className="flex gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[13px]">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
      <div className="grid min-w-0 gap-0.5">
        <p className="break-words whitespace-pre-wrap text-red-700 dark:text-red-300">
          {message}
        </p>
        {recovery ? (
          <p className="text-xs text-muted-foreground">{recovery}</p>
        ) : null}
      </div>
    </div>
  )
}
