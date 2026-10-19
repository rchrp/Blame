import * as React from "react"
import {
  CircleCheckBigIcon,
  FilePenLineIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  GlobeIcon,
  MessageCircleQuestionMarkIcon,
  MonitorPlayIcon,
  NetworkIcon,
  SearchIcon,
  SquareTerminalIcon,
  UsersIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { describeToolCall, toolCallSource, type ToolCallActivity } from "./describe-tool-call"
import { ToolCallBodyView } from "./tool-call-bodies"
import type { ToolCallChip, ToolCallFamily } from "./tool-call-view"

const familyIcons: Record<ToolCallFamily, LucideIcon> = {
  agent: UsersIcon,
  command: SquareTerminalIcon,
  edit: FilePenLineIcon,
  finish: CircleCheckBigIcon,
  graph: NetworkIcon,
  list: FolderTreeIcon,
  other: WrenchIcon,
  preview: MonitorPlayIcon,
  question: MessageCircleQuestionMarkIcon,
  read: FileTextIcon,
  search: SearchIcon,
  skill: ZapIcon,
  test: FlaskConicalIcon,
  web: GlobeIcon,
}

// One tool call in the agent's work log. Collapsed, it reads as a sentence
// ("Edited sync-service.ts +12 −3"); opened, it shows the detail that matters
// for that tool.
export function ToolCallItem({
  activity,
  avatar,
  entering,
  hasFullDetail,
  onLoadDetail,
  onOpenFile,
  running,
  value,
}: {
  activity: ToolCallActivity
  // Replaces the tool icon, for specialist agents with an avatar.
  avatar?: React.ReactNode
  entering: boolean
  hasFullDetail: boolean
  onLoadDetail: () => Promise<string>
  // Opens a file of the workspace in the editor.
  onOpenFile?: (path: string) => void
  running: boolean
  value: string
}) {
  const [fullDetail, setFullDetail] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const view = React.useMemo(
    () =>
      describeToolCall(
        toolCallSource(
          fullDetail ? { ...activity, detail: fullDetail } : activity,
          running
        )
      ),
    [activity, fullDetail, running]
  )
  const Icon = familyIcons[view.family]
  const expandable = view.bodies.length > 0 || hasFullDetail

  async function loadDetail() {
    setLoading(true)
    try {
      setFullDetail(await onLoadDetail())
    } finally {
      setLoading(false)
    }
  }

  return (
    <AccordionItem
      value={value}
      disabled={!expandable}
      className={cn("border-b-0!", entering && "chat-enter-step")}
    >
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-2 text-sm">
        {/* Keyed by state: the icon pops when the step finishes. */}
        <span
          key={running ? "running" : "idle"}
          className={cn(
            "flex size-8 items-center justify-center text-muted-foreground",
            running ? "chat-step-running" : entering && "chat-step-done",
            view.failed && "text-red-600 dark:text-red-400"
          )}
        >
          {avatar ?? <Icon className="size-4" />}
        </span>
        <div className="min-w-0">
          <AccordionTrigger
            className={cn(
              "min-h-8 items-center gap-2 py-0 hover:no-underline",
              !expandable &&
                "cursor-default disabled:opacity-100 **:data-[slot=accordion-trigger-icon]:hidden"
            )}
          >
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-normal">
              <span
                className={cn(
                  "shrink-0 text-muted-foreground",
                  running && "agent-activity-running"
                )}
              >
                {view.verb}
              </span>
              {view.target ? (
                <span
                  className={cn(
                    "min-w-0 truncate text-foreground",
                    view.target.mono && "font-mono text-[12.5px]"
                  )}
                  title={view.target.title ?? view.target.text}
                >
                  {view.target.text}
                </span>
              ) : null}
              {view.chips.length ? (
                <span className="flex shrink-0 items-center gap-1 self-center">
                  {view.chips.map((chip) => (
                    <Chip key={chip.label} chip={chip} />
                  ))}
                </span>
              ) : null}
            </span>
          </AccordionTrigger>
          {expandable ? (
            <AccordionContent className="grid gap-2 pt-1.5 pb-1">
              {view.bodies.map((body, index) => (
                <ToolCallBodyView
                  key={`${body.type}-${index}`}
                  body={body}
                  onOpenFile={onOpenFile}
                />
              ))}
              {hasFullDetail && !fullDetail ? (
                <Button
                  className="justify-self-start"
                  disabled={loading}
                  onClick={() => void loadDetail()}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {loading ? "Loading full detail" : "Show full detail"}
                </Button>
              ) : null}
            </AccordionContent>
          ) : null}
        </div>
      </div>
    </AccordionItem>
  )
}

const chipTones: Record<NonNullable<ToolCallChip["tone"]>, string> = {
  add: "font-mono text-emerald-600 dark:text-emerald-400",
  remove: "font-mono text-red-600 dark:text-red-400",
  danger: "rounded-md bg-red-500/10 px-1.5 text-red-700 dark:text-red-300",
  neutral: "rounded-md bg-muted px-1.5 text-muted-foreground",
  success: "rounded-md bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300",
  warning: "rounded-md bg-amber-500/10 px-1.5 text-amber-700 dark:text-amber-300",
}

function Chip({ chip }: { chip: ToolCallChip }) {
  return (
    <span
      className={cn(
        "max-w-48 truncate py-px text-[11px] leading-4 font-medium",
        chipTones[chip.tone ?? "neutral"],
        chip.mono && "font-mono"
      )}
      title={chip.title ?? chip.label}
    >
      {chip.label}
    </span>
  )
}
