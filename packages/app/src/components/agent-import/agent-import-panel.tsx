import * as React from "react"
import {
  AlertCircleIcon,
  CheckIcon,
  EyeOffIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { AgentImportSourceIcon } from "@/components/agent-import/agent-import-sources"
import {
  availableLine,
  availableSourceIds,
  sourceCaption,
  sourceStatus,
  categoryLabel,
  choicesFrom,
  defaultSelection,
  groupItems,
  importableItems,
  resultLine,
} from "@/components/agent-import/agent-import-model"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type {
  AgentImportClient,
  AgentImportItem,
  AgentImportResult,
  AgentImportScan,
  AgentImportSource,
  AgentImportSourceId,
} from "@/context/platform"
import { cn } from "@/lib/utils"

// The review of what other tools hold: per source, per category, per item.
// Nothing is imported until the person ticks it and confirms. Secrets are
// never here: main masks them before the scan reaches this screen.
export function AgentImportPanel({
  client,
  scan,
  onFinished,
  onSkip,
  finishLabel = "Continue",
  skipLabel = "Skip for now",
}: {
  client: AgentImportClient
  scan: AgentImportScan
  onFinished(result?: AgentImportResult): void
  onSkip?: () => void
  finishLabel?: string
  skipLabel?: string
}) {
  const [step, setStep] = React.useState<"sources" | "items">("sources")
  const [picked, setPicked] = React.useState(() => availableSourceIds(scan))
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [importing, setImporting] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [result, setResult] = React.useState<AgentImportResult>()
  const choices = choicesFrom(scan, selected)

  function togglePicked(id: AgentImportSourceId) {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // The items of the sources just picked, with their defaults ticked.
  function next() {
    setSelected(defaultSelection(scan, picked))
    setStep("items")
  }

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function run() {
    setImporting(true)
    setError(undefined)
    try {
      setResult(await client.apply(choices))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The import failed.")
    } finally {
      setImporting(false)
    }
  }

  if (result)
    return (
      <div className="grid gap-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckIcon className="size-4 text-emerald-600" />
          {resultLine(result)}
        </div>
        <ResultList result={result} />
        <div>
          <Button
            className="h-10 rounded-full px-5"
            onClick={() => onFinished(result)}
          >
            {finishLabel}
          </Button>
        </div>
      </div>
    )

  if (step === "sources")
    return (
      <div className="grid gap-4">
        <p className="text-sm text-foreground/65">
          Pick the tools to bring your setup from.
        </p>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {scan.sources.map((source) => (
            <SourceTile
              key={source.id}
              source={source}
              selected={picked.has(source.id)}
              onToggle={() => togglePicked(source.id)}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="h-10 rounded-full px-5"
            disabled={picked.size === 0}
            onClick={next}
          >
            Next
          </Button>
          {onSkip ? (
            <Button
              variant="outline"
              className="h-10 rounded-full bg-background/60 px-4 backdrop-blur"
              onClick={onSkip}
            >
              {skipLabel}
            </Button>
          ) : null}
        </div>
      </div>
    )

  return (
    <div className="grid gap-4">
      <div className="grid max-h-[22rem] gap-5 overflow-y-auto pr-1">
        {scan.sources
          .filter((source) => picked.has(source.id))
          .map((source) => {
            const groups = groupItems(source.items)
            const available = availableLine(source.items)
            return (
              <section key={source.id} className="grid gap-2">
                <header className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">{source.label}</h3>
                  <span className="truncate font-mono text-[11px] text-foreground/50">
                    {source.location}
                  </span>
                </header>
                {groups.map((group) => (
                  <div key={group.category} className="grid gap-1">
                    <h4 className="text-[11px] font-medium tracking-wide text-foreground/50 uppercase">
                      {categoryLabel(group.category)}
                    </h4>
                    <ul className="grid gap-1">
                      {group.items.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          checked={selected.has(item.id)}
                          onCheckedChange={(on) => toggle(item.id, on)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {available ? (
                  <p className="text-xs text-foreground/50">{available}.</p>
                ) : null}
                {source.unsupported.length ? (
                  <ul className="grid gap-0.5 text-xs text-foreground/50">
                    {source.unsupported.map((entry) => (
                      <li key={entry.label}>
                        Not imported: {entry.label} ({entry.count}).{" "}
                        {entry.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            )
          })}
      </div>
      <p className="text-xs text-foreground/50">
        Values like tokens stay on this computer, in Blame's settings, and are
        hidden here. Sign-ins (OAuth) and connectors kept on claude.ai or
        ChatGPT cannot be copied: authorize or add them again in Settings → MCP.
      </p>
      {error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircleIcon className="size-4" />
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="h-10 rounded-full px-5"
          disabled={importing || choices.length === 0}
          onClick={() => void run()}
        >
          {importing ? <LoaderCircleIcon className="animate-spin" /> : null}
          {choices.length
            ? `Import ${choices.length} ${choices.length === 1 ? "item" : "items"}`
            : "Nothing selected"}
        </Button>
        <Button
          variant="outline"
          className="h-10 rounded-full bg-background/60 px-4 backdrop-blur"
          disabled={importing}
          onClick={() => setStep("sources")}
        >
          Back
        </Button>
      </div>
    </div>
  )
}

function SourceTile({
  source,
  selected,
  onToggle,
}: {
  source: AgentImportSource
  selected: boolean
  onToggle(): void
}) {
  const available = sourceStatus(source) === "available"
  return (
    <li>
      <button
        type="button"
        disabled={!available}
        aria-pressed={available ? selected : undefined}
        onClick={onToggle}
        className={cn(
          "relative flex w-full flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-colors",
          available
            ? "border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/[0.06]"
            : "cursor-not-allowed border-transparent opacity-60",
          available &&
            selected &&
            "border-primary/60 bg-primary/10 hover:bg-primary/10"
        )}
      >
        <AgentImportSourceIcon
          id={source.id}
          label={source.label}
          active={available}
        />
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">{source.label}</span>
          <span className="text-xs text-foreground/55">
            {sourceCaption(source)}
          </span>
        </span>
        {available && selected ? (
          <span className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3" strokeWidth={3} />
          </span>
        ) : null}
      </button>
    </li>
  )
}

function ItemRow({
  item,
  checked,
  onCheckedChange,
}: {
  item: AgentImportItem
  checked: boolean
  onCheckedChange(on: boolean): void
}) {
  const conflict = item.state === "conflict"
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-xl px-2 py-1.5",
        checked && "bg-foreground/[0.04]"
      )}
    >
      <Checkbox
        className="mt-1"
        aria-label={
          conflict
            ? `Import ${item.name} as ${item.renameTo}`
            : `Import ${item.name}`
        }
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{item.name}</span>
          {item.scope ? (
            <span
              className="max-w-48 truncate rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] text-foreground/60"
              title={item.scope}
            >
              project {item.scope}
            </span>
          ) : null}
          {item.secrets.length ? (
            <span
              className="flex items-center gap-1 rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] text-foreground/60"
              title={item.secrets.join(", ")}
            >
              <EyeOffIcon className="size-3" />
              {item.secrets.length} hidden
            </span>
          ) : null}
        </div>
        {item.summary ? (
          <span className="truncate font-mono text-xs text-foreground/55">
            {item.summary}
          </span>
        ) : null}
        {conflict ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Blame already has a different {item.name}. Ticked, it is imported as{" "}
            {item.renameTo}; unticked, it is skipped.
          </span>
        ) : null}
        {item.warnings.map((warning) => (
          <span key={warning} className="text-xs text-foreground/55">
            {warning}
          </span>
        ))}
      </div>
    </li>
  )
}

function ResultList({ result }: { result: AgentImportResult }) {
  const notable = result.outcomes.filter(
    (outcome) => outcome.message || outcome.status === "failed"
  )
  if (!notable.length) return null
  return (
    <ul className="grid gap-1 text-xs text-foreground/60">
      {notable.map((outcome) => (
        <li key={outcome.id}>
          {outcome.name}: {outcome.message ?? outcome.status}
        </li>
      ))}
    </ul>
  )
}

export function importCount(scan: AgentImportScan) {
  return importableItems(scan).length
}
