import * as React from "react"
import type {
  EpicState,
  OrchestratorConversationState,
} from "@blame/agent-runtime/engine-protocol"
import { GitBranchIcon, PauseIcon, PlayIcon, Settings2Icon } from "lucide-react"

import {
  formatMicroUsd,
  type Epic,
} from "@/components/orchestrator/data/epic-data"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { ExpandedAgentStats } from "@/components/backlog/drawer/user-story-drawer-sidebar"
import { useEngineCompaction } from "@/components/backlog/drawer/story-context-compaction"
import { useProjectDiffStats } from "@/components/backlog/development/project-diff-stats"
import { engineStatsSource } from "@/components/chat/engine/engine-stats"
import { epicAmbitionKey } from "@/lib/conversation-ambition"
import { EpicBoardView } from "./epic-board-view"
import type { EpicBoardGroup } from "./data/epic-board"
import { useEpicModels, orchestratorPreference } from "./data/use-epic-models"
import type { useEpicConversation } from "./data/use-epic-conversation"

export function EpicStats({
  epic,
  chat,
  groups,
  pausing,
  onChangeStatus,
  onOpenSettings,
  onOpenStory,
}: {
  epic: Epic
  chat: ReturnType<typeof useEpicConversation>
  groups: EpicBoardGroup[]
  pausing: boolean
  onChangeStatus: () => void
  onOpenSettings: () => void
  onOpenStory: (id: string) => void
}) {
  const { state, transcript, running, conversation, session } = chat
  const models = useEpicModels()
  const storyStats = useProjectDiffStats()
  const changes = React.useMemo(() => {
    const measured = groups
      .filter((group) => group.id !== "rejected")
      .flatMap((group) =>
        group.entries.flatMap(({ story }) => storyStats.get(story.id) ?? [])
      )
    if (!measured.length) return undefined
    return measured.reduce(
      (sum, diff) => ({
        additions: sum.additions + diff.additions,
        deletions: sum.deletions + diff.deletions,
        files: sum.files + diff.files,
      }),
      { additions: 0, deletions: 0, files: 0 }
    )
  }, [groups, storyStats])
  const recorded =
    transcript && conversation
      ? engineStatsSource({
          id: epic.id,
          transcript,
          running,
          runs: conversation.runs,
        })
      : undefined
  const configured = orchestratorPreference(epic.settings.orchestratorModel)
  const model =
    recorded?.model ??
    configured ??
    (models.currentModel && {
      modelId: models.currentModel.id,
      providerId: models.currentModel.provider.id,
      reasoningEffort: models.currentVariant,
    })
  const source = {
    ...recorded,
    id: epic.id,
    model,
    agentModels: model ? [model] : [],
  }
  const compaction = useEngineCompaction({
    available: Boolean(transcript?.items.length),
    running,
    session,
  })
  const spend = state?.session ? state.spend : undefined
  const budget = spend?.budgetMicroUsd ?? epic.settings.budgetMicroUsd
  const paused = epic.status === "paused"
  const closed = epic.status === "completed" || epic.status === "discarded"
  return (
    <ExpandedAgentStats
      actions={[
        ...(closed
          ? []
          : [
              <Button
                key="pause"
                type="button"
                className="border bg-background/90 shadow-sm"
                size="icon-sm"
                variant="outline"
                disabled={pausing}
                aria-label={paused ? "Resume all" : "Pause all"}
                title={paused ? "Resume all" : "Pause all"}
                onClick={onChangeStatus}
              >
                {paused ? <PlayIcon /> : <PauseIcon />}
              </Button>,
            ]),
        <Button
          key="settings"
          type="button"
          className="border bg-background/90 shadow-sm"
          size="icon-sm"
          variant="outline"
          aria-label="Epic settings"
          title="Epic settings"
          onClick={onOpenSettings}
        >
          <Settings2Icon />
        </Button>,
      ]}
      source={source}
      contextLimitKey={epicAmbitionKey(epic.id)}
      compaction={compaction}
      diffStats={changes}
      cost={
        spend ? (
          <span
            title={`Orchestrator ${formatMicroUsd(spend.orchestratorMicroUsd)} · Stories ${formatMicroUsd(spend.storiesMicroUsd)}${spend.unpricedRequests ? " · Some requests have no known price" : ""}`}
          >
            {spend.unpricedRequests ? "≥ " : ""}
            {formatMicroUsd(spend.totalMicroUsd)}
          </span>
        ) : (
          "—"
        )
      }
      summary={
        <div className="grid min-w-0 gap-1.5 border-b pb-3 text-xs text-muted-foreground">
          <div className="grid min-w-0 gap-0.5" role="status">
            {paused && <PauseStatus state={state} />}
            {closed ? (
              <span className="capitalize">{epic.status}</span>
            ) : (
              <ConversationStatus paused={paused} state={state} />
            )}
          </div>
          <div
            className="flex min-w-0 items-start gap-1.5"
            title="Verified stories merge into the epic branch for your review"
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 break-all">
              {epic.branch ? (
                <code>{epic.branch}</code>
              ) : (
                "Branch created when it starts"
              )}
              {epic.targetBranch && (
                <>
                  {" "}
                  → <code>{epic.targetBranch}</code>
                </>
              )}
            </span>
          </div>
          {budget !== undefined && (
            <span
              className={cn("tabular-nums", spend?.spent && "text-destructive")}
            >
              Budget {formatMicroUsd(budget)}
              {spend?.spent && " · spent"}
            </span>
          )}
        </div>
      }
    >
      <EpicBoardView
        groups={groups}
        modelName={models.modelName}
        onOpenStory={onOpenStory}
      />
    </ExpandedAgentStats>
  )
}

const conversationLabels: Partial<
  Record<OrchestratorConversationState, { text: string; tone: string }>
> = {
  idle: { text: "Ready", tone: "" },
  working: { text: "Orchestrator working", tone: "text-foreground" },
  waiting: { text: "Waiting for its stories", tone: "" },
  replied: { text: "Your turn", tone: "text-foreground" },
  asking: {
    text: "Asks you a question",
    tone: "text-foreground",
  },
  finished: {
    text: "Done: your review",
    tone: "text-foreground",
  },
  stopped: {
    text: "Orchestrator stopped",
    tone: "text-foreground",
  },
  failed: { text: "Orchestrator failed", tone: "text-destructive" },
}

// "Paused" only once the host stopped what the pause meant to stop.
function PauseStatus({ state }: { state?: EpicState }) {
  const pause = state?.pause
  if (pause?.phase === "paused")
    return <span className="font-medium text-foreground">Paused</span>
  if (pause?.error)
    return (
      <span
        className="max-w-full font-medium break-words text-destructive"
        role="alert"
      >
        Not fully paused: {pause.error}
      </span>
    )
  return <span className="font-medium text-muted-foreground">Pausing…</span>
}

function ConversationStatus({
  paused,
  state,
}: {
  paused: boolean
  state?: EpicState
}) {
  const blocked = state?.blocked?.length ?? 0
  const quiet =
    state?.conversation === "waiting" ||
    state?.conversation === "idle" ||
    state?.conversation === "working"
  const needsYou = "text-foreground"
  // What only the person can fix comes before the orchestrator's state: a
  // problem of the epic itself (its branch gone, its file unreadable), then
  // stories only they can start.
  const label =
    state?.error && quiet
      ? { text: "Needs you: see the conversation", tone: needsYou }
      : blocked && quiet
        ? {
            text:
              blocked === 1
                ? "1 story needs you to start"
                : `${blocked} stories need you to start`,
            tone: needsYou,
          }
        : // Paused, a sleeping orchestrator is implied; one the person talks to is not.
          paused &&
            (state?.conversation === "waiting" ||
              state?.conversation === "idle")
          ? undefined
          : state
            ? conversationLabels[state.conversation]
            : { text: "Ready", tone: "" }
  if (!label) return null
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-medium", label.tone)}
      title={state?.error && quiet ? state.error : undefined}
    >
      {state?.conversation === "working" && !blocked && !state.error ? (
        <span aria-hidden="true" className="agent-activity-mark" />
      ) : null}
      {label.text}
    </span>
  )
}
