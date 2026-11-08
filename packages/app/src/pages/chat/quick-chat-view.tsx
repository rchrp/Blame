import type { ComponentProps, CSSProperties } from "react"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import type { QuickChat } from "@/components/chat/data/quick-chat-data"
import { QuickChatEmptyState } from "@/components/chat/quick-chat-empty-state"
import { ModelSelector } from "@/components/model/model-selector"
import { ConversationPersonalizationMenu } from "@/components/personalization/personalization-menu"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import { BranchSelector } from "@/components/backlog/drawer/branch-selector"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { isBoolean, useUiMemory } from "@/lib/ui-memory"
import { chatAmbitionKey } from "@/lib/conversation-ambition"
import { cn } from "@/lib/utils"
import { QuickChatStats } from "./quick-chat-stats"
import { QuickChatStatus } from "./quick-chat-status"

const bottomBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies CSSProperties

type QuickChatViewProps = {
  conversationId?: string
  emptyConversation: boolean
  status: ComponentProps<typeof QuickChatStatus>
  timeline?: ComponentProps<typeof AgentConversationTimeline>
  composer: ComponentProps<typeof AgentConversationComposer>
  onSuggestion: ComponentProps<typeof QuickChatEmptyState>["onSuggestion"]
  preview: ComponentProps<typeof ProjectRunConfigurationPreviewWarmup>
  // The chat whose agent stats float at the top right, once it has run.
  stats?: QuickChat
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
            <MessageScrollerProvider
              key={conversationId ?? "new-chat"}
              memoryKey={conversationId}
            >
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent
                    aria-busy={composer.agentRunning}
                    className={cn(
                      "mx-auto w-full max-w-[calc(56rem+var(--chat-stats-inset))] gap-10 px-4 pt-[calc(var(--header-height)+1rem)] pb-48 transition-[max-width,padding] duration-500 ease-out md:px-8 md:pr-[calc(2rem+var(--chat-stats-inset))]",
                      // The first message starts below the folded pill.
                      stats && !statsExpanded && "pt-[calc(var(--header-height)+4rem)]"
                    )}
                  >
                    <QuickChatStatus {...status} />
                    {timeline ? <AgentConversationTimeline {...timeline} /> : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton className="bottom-40 md:bottom-44" />
              </MessageScroller>
            </MessageScrollerProvider>
            <div
              className={
                emptyConversation
                  ? "absolute inset-0 z-20 flex flex-col justify-center overflow-y-auto px-3 pt-[calc(var(--header-height)+1rem)] pb-5 md:px-5"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-10 md:pt-12"
              }
            >
              <div
                className={
                  emptyConversation
                    ? "hidden"
                    : "absolute inset-0 bg-background/40 backdrop-blur-xl"
                }
                style={bottomBlurMask}
              />
              <div className="pointer-events-auto relative px-3 pb-3 md:px-5 md:pb-5">
                <div className="mx-auto w-full max-w-[calc(56rem+var(--chat-stats-inset))] pr-(--chat-stats-inset) transition-[max-width,padding] duration-500 ease-out">
                  {emptyConversation ? (
                    <QuickChatEmptyState onSuggestion={onSuggestion} />
                  ) : null}
                  <AgentConversationComposer
                    {...composer}
                    personalizationMenu={
                      <ConversationPersonalizationMenu
                        ambitionKey={chatAmbitionKey(conversationId)}
                      />
                    }
                    minHeight={emptyConversation ? "min-h-44" : "min-h-24"}
                    toolbarEnd={
                      <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
                        {/* A chat works in the project folder, on its branch. */}
                        {emptyConversation ? <BranchSelector readOnly /> : null}
                        <div className="w-[28rem] max-w-full min-w-0">
                          <ModelSelector
                            role="agent"
                            warnOnModelChange={!emptyConversation}
                          />
                        </div>
                      </div>
                    }
                  />
                </div>
              </div>
            </div>
            {stats ? (
              <QuickChatStats
                chat={stats}
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
