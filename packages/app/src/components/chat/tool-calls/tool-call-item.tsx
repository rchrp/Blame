import * as React from "react"
import { SourceStack } from "../web-research/web-sources"
import { useWebResearch } from "../web-research/web-research-context"
import {
  CircleCheckBigIcon,
  FilePenLineIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  GlobeIcon,
  ListChecksIcon,
  LoaderCircleIcon,
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

import {
  describeToolCall,
  toolCallSource,
  type ToolCallActivity,
} from "./describe-tool-call"
import { ToolCallScreenshots } from "../screenshots/screenshot-tool-call"
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
  plan: ListChecksIcon,
  preview: MonitorPlayIcon,
  question: MessageCircleQuestionMarkIcon,
  read: FileTextIcon,
  search: SearchIcon,
  skill: ZapIcon,
  test: FlaskConicalIcon,
  web: GlobeIcon,
}

// Domain tools can supply human-readable details while keeping the shared work log.
export type ToolCallDetail = {
  family: ToolCallFamily
  verb: string
  content: React.ReactNode
  inlineContent?: React.ReactNode
  needsAttention?: boolean
  failed?: boolean
}
const ToolCallDetails = React.createContext<
  ReadonlyMap<string, ToolCallDetail> | undefined
>(undefined)
export const ToolCallDetailsProvider = ToolCallDetails.Provider

// One tool call in the agent's work log. Collapsed, it reads as a sentence
// ("Edited sync-service.ts +12 −3"); opened, it shows the detail that matters
// for that tool.
export function ToolCallItem({
  activity,
  entering,
  hasFullDetail,
  onLoadDetail,
  onOpenFile,
  running,
  value,
}: {
  activity: ToolCallActivity
  entering: boolean
  hasFullDetail: boolean
  onLoadDetail: () => Promise<string>
  // Opens a file of the workspace in the editor.
  onOpenFile?: (path: string) => void
  running: boolean
  value: string
}) {
  const [fullDetail, setFullDetail] = React.useState<string>()
  const { details, rememberDetail } = useWebResearch()
  const researchDetail = details.get(activity.id ?? "")
  const [loading, setLoading] = React.useState(false)
  const view = React.useMemo(
    () =>
      describeToolCall(
        toolCallSource(
          fullDetail || researchDetail
            ? { ...activity, detail: fullDetail ?? researchDetail! }
            : activity,
          running
        )
      ),
    [activity, fullDetail, researchDetail, running]
  )
  const detail = React.useContext(ToolCallDetails)?.get(activity.id ?? "")
  const Icon = familyIcons[detail?.family ?? view.family]
  const expandable = detail
    ? !detail.needsAttention
    : view.bodies.length > 0 || hasFullDetail
  const screenshots = view.bodies.find((body) => body.type === "screenshot")
  const failed = detail?.failed || view.failed
  const verb = detail?.verb ?? view.verb

  async function loadDetail() {
    setLoading(true)
    try {
      const detail = await onLoadDetail()
      setFullDetail(detail)
      const id = activity.id
      if (view.family === "web" && id) rememberDetail(id, detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AccordionItem
      value={value}
      disabled={!expandable}
      className={cn(
        "group/tool-call border-b-0!",
        entering && "chat-enter-step"
      )}
    >
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-1 text-sm">
        <span
          aria-hidden="true"
          className={cn(
            "flex h-8 items-center justify-center text-muted-foreground",
            failed && "text-destructive"
          )}
        >
          {running ? (
            <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Icon className="size-3.5" />
          )}
        </span>
        <div className="min-w-0">
          <AccordionTrigger
            className={cn(
              "min-h-8 min-w-0 items-center gap-2 px-1.5 py-0 transition-colors hover:bg-foreground/4 hover:no-underline **:data-[slot=accordion-trigger-icon]:size-3.5",
              !expandable &&
                "cursor-default disabled:opacity-100 **:data-[slot=accordion-trigger-icon]:hidden"
            )}
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-1 font-normal">
              <span className="font-medium text-muted-foreground">{verb}</span>
              {!detail && view.target ? (
                <span
                  className={cn(
                    "max-w-full min-w-0 truncate text-foreground",
                    view.target.mono && "font-mono text-[12.5px]"
                  )}
                  title={view.target.title ?? view.target.text}
                >
                  {view.target.text}
                </span>
              ) : null}
              {running && !/^running\b/i.test(verb) && (
                <span className="text-xs text-muted-foreground">Running</span>
              )}
              {view.webSources?.length ? (
                <span className="self-center">
                  <SourceStack sources={view.webSources} />
                </span>
              ) : null}
              {view.chips.length ? (
                <span className="flex max-w-full flex-wrap items-center gap-1 self-center">
                  {view.chips.map((chip) => (
                    <Chip key={chip.label} chip={chip} />
                  ))}
                </span>
              ) : null}
            </span>
          </AccordionTrigger>
          {detail?.needsAttention ? detail.content : null}
          {detail?.inlineContent}
          {screenshots ? (
            // Always in sight; the opened call shows it larger instead.
            <ToolCallScreenshots
              className="pt-1 pb-1.5 group-data-[state=open]/tool-call:hidden"
              pending={screenshots.pending}
              screenshots={screenshots.screenshots}
            />
          ) : null}
          {expandable ? (
            <AccordionContent className="mt-1 grid min-w-0 gap-2 border-l border-foreground/10 pb-1.5 pl-3">
              {detail
                ? detail.content
                : view.bodies.map((body, index) => (
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
  success:
    "rounded-md bg-emerald-500/10 px-1.5 text-emerald-700 dark:text-emerald-300",
  warning:
    "rounded-md bg-amber-500/10 px-1.5 text-amber-700 dark:text-amber-300",
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
