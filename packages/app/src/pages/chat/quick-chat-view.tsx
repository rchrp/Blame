import type { ComponentProps } from "react"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { QuickChatEmptyState } from "@/components/chat/quick-chat-empty-state"
import { ModelSelector } from "@/components/model/model-selector"
import { ConversationPersonalizationMenu } from "@/components/personalization/personalization-menu"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import { BranchSelector } from "@/components/backlog/drawer/branch-selector"
import { SelectorGroup } from "@/components/ui/selector-group"
import { ConversationSurface } from "@/components/chat/conversation-surface"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"
import { chatAmbitionKey } from "@/lib/conversation-ambition"
import { chatUltraKey } from "@/lib/conversation-ultra"
import { useConversationUltra } from "@/lib/use-conversation-ultra"
import { cn } from "@/lib/utils"
import { QuickChatStats } from "./quick-chat-stats"
import { QuickChatStatus } from "./quick-chat-status"

type QuickChatViewProps = {
  conversationId?: string
  emptyConversation: boolean
  status: ComponentProps<typeof QuickChatStatus>
  timeline?: ComponentProps<typeof AgentConversationTimeline>
  composer: ComponentProps<typeof AgentConversationComposer>
  onSuggestion: ComponentProps<typeof QuickChatEmptyState>["onSuggestion"]
  preview: ComponentProps<typeof ProjectRunConfigurationPreviewWarmup>
  // The agent stats floating at the top right, once the chat has run.
  stats?: Omit<
    ComponentProps<typeof QuickChatStats>,
    "expanded" | "onExpandedChange"
  >
}

export function QuickChatView({
  conversationId,
  emptyConversation,
  status,
  timeline,
  composer,
  onSuggestion,
  preview,
  stats,
}: QuickChatViewProps) {
  // The stats panel opens in full; it can fold into a small pill.
  const [statsExpanded, setStatsExpanded] = useUiMemory(
    "chat.stats-expanded",
    true,
    isBoolean
  )
  return (
    <>
      <div className="@container flex h-svh min-h-0 min-w-0 flex-col overflow-hidden md:h-[calc(100svh_-_1rem)]">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
          <main
            className={cn(
              "relative flex min-h-0 min-w-0 flex-col overflow-hidden [--chat-stats-inset:0px]",
              // When there is room, the conversation keeps clear of the open panel.
              stats && statsExpanded && "@4xl:[--chat-stats-inset:21rem]"
            )}
          >
            <ConversationSurface
              conversationId={conversationId}
              running={composer.agentRunning}
              clearPill={Boolean(stats && !statsExpanded)}
              emptyState={
                emptyConversation ? (
                  <QuickChatEmptyState onSuggestion={onSuggestion} />
                ) : undefined
              }
              composer={
                <AgentConversationComposer
                  {...composer}
                  personalizationMenu={
                    <ConversationPersonalizationMenu
                      ambitionKey={chatAmbitionKey(conversationId)}
                    />
                  }
                  minHeight={emptyConversation ? "min-h-28" : "min-h-24"}
                  toolbarStart={
                    emptyConversation && (
                      <SelectorGroup>
                        <BranchSelector readOnly />
                      </SelectorGroup>
                    )
                  }
                  toolbarEnd={
                    <QuickChatModelSelector
                      conversationId={conversationId}
                      warnOnModelChange={!emptyConversation}
                    />
                  }
                />
              }
            >
              <QuickChatStatus {...status} />
              {timeline ? <AgentConversationTimeline {...timeline} /> : null}
            </ConversationSurface>
            {stats ? (
              <QuickChatStats
                {...stats}
                expanded={statsExpanded}
                onExpandedChange={setStatsExpanded}
              />
            ) : null}
          </main>
        </div>
      </div>
      <ProjectRunConfigurationPreviewWarmup {...preview} />
    </>
  )
}

// The chat's model, its thinking mode and ultra mode, which the chat keeps
// as set for its next messages.
function QuickChatModelSelector({
  conversationId,
  warnOnModelChange,
}: {
  conversationId?: string
  warnOnModelChange: boolean
}) {
  const [ultra, setUltra] = useConversationUltra(chatUltraKey(conversationId))
  return (
    <ModelSelector
      appearance="composer"
      role="agent"
      ultra={{ checked: ultra, onCheckedChange: setUltra }}
      warnOnModelChange={warnOnModelChange}
    />
  )
}
