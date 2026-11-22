import type { CSSProperties, ReactNode } from "react"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { cn } from "@/lib/utils"

const bottomBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies CSSProperties

export function ConversationSurface({
  children,
  composer,
  emptyState,
  background,
  conversationId,
  running,
  clearPill,
}: {
  children?: ReactNode
  composer: ReactNode
  emptyState?: ReactNode
  background?: ReactNode
  conversationId?: string
  running?: boolean
  clearPill?: boolean
}) {
  return (
    <>
      {background}
      <MessageScrollerProvider
        key={conversationId ?? "new"}
        memoryKey={conversationId}
      >
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent
              aria-busy={running}
              className={cn(
                "mx-auto w-full max-w-[calc(56rem+var(--chat-stats-inset))] gap-10 px-4 pt-[calc(var(--conversation-top,var(--header-height))+1rem)] pb-48 transition-[max-width,padding] duration-500 ease-out md:px-8 md:pr-[calc(2rem+var(--chat-stats-inset))]",
                // The first message starts below the folded pill.
                clearPill &&
                  "pt-[calc(var(--conversation-top,var(--header-height))+4rem)]"
              )}
            >
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton className="bottom-40 md:bottom-44" />
        </MessageScroller>
      </MessageScrollerProvider>
      <div
        className={
          emptyState
            ? "absolute inset-0 z-20 flex flex-col overflow-y-auto px-3 pt-[calc(var(--conversation-top,var(--header-height))+1rem)] pb-5 md:px-5"
            : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-10 md:pt-12"
        }
      >
        <div
          className={
            emptyState
              ? "hidden"
              : "absolute inset-0 bg-background/40 backdrop-blur-xl"
          }
          style={bottomBlurMask}
        />
        <div
          className={cn(
            "pointer-events-auto relative px-3 pb-3 md:px-5 md:pb-5",
            emptyState && "my-auto"
          )}
        >
          <div className="mx-auto w-full max-w-[calc(56rem+var(--chat-stats-inset))] pr-(--chat-stats-inset) transition-[max-width,padding] duration-500 ease-out">
            {emptyState}
            {composer}
          </div>
        </div>
      </div>
    </>
  )
}
