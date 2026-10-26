import type { ComponentProps, CSSProperties } from "react"
import {
  AgentConversationComposer,
  AgentConversationTimeline,
} from "@/components/chat/agent-conversation"
import { QuickChatEmptyState } from "@/components/chat/quick-chat-empty-state"
import { ModelSelector } from "@/components/model/model-selector"
import { ProjectRunConfigurationPreviewWarmup } from "@/components/backlog/board/project-run-preview-warmup"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
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
}

export function QuickChatView({
  conversationId,
  emptyConversation,
  status,
  timeline,
  composer,
  onSuggestion,
  preview,
}: QuickChatViewProps) {
  return (
    <>
      <div className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden md:h-[calc(100svh_-_1rem)]">
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
          <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
            <MessageScrollerProvider
              key={conversationId ?? "new-chat"}
              memoryKey={conversationId}
            >
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent
                    aria-busy={composer.agentRunning}
                    className="mx-auto w-full max-w-4xl gap-10 px-4 pt-[calc(var(--header-height)+1rem)] pb-48 md:px-8"
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
                <div className="mx-auto w-full max-w-4xl">
                  {emptyConversation ? (
                    <QuickChatEmptyState onSuggestion={onSuggestion} />
                  ) : null}
                  <AgentConversationComposer
                    {...composer}
                    minHeight={emptyConversation ? "min-h-44" : "min-h-24"}
                    toolbarEnd={
                      <div className="w-[28rem] max-w-full min-w-0">
                        <ModelSelector
                          role="agent"
                          warnOnModelChange={!emptyConversation}
                        />
                      </div>
                    }
                  />
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
      <ProjectRunConfigurationPreviewWarmup {...preview} />
    </>
  )
}
