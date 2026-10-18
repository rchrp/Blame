import * as React from "react"
import { ArrowDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const bottomThreshold = 24

type MessageScrollerContextValue = {
  atBottom: boolean
  followingRef: React.RefObject<boolean>
  scrollToLatest: () => void
  setAtBottom: React.Dispatch<React.SetStateAction<boolean>>
  viewportRef: React.RefObject<HTMLDivElement | null>
}

const MessageScrollerContext =
  React.createContext<MessageScrollerContextValue | null>(null)

function MessageScrollerProvider({ children }: { children: React.ReactNode }) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const followingRef = React.useRef(true)
  const [atBottom, setAtBottom] = React.useState(true)

  const scrollToLatest = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    followingRef.current = true
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    })
    setAtBottom(true)
  }, [])

  const value = React.useMemo(
    () => ({
      atBottom,
      followingRef,
      scrollToLatest,
      setAtBottom,
      viewportRef,
    }),
    [atBottom, scrollToLatest]
  )

  return (
    <MessageScrollerContext.Provider value={value}>
      {children}
    </MessageScrollerContext.Provider>
  )
}

function MessageScroller({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller"
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { followingRef, setAtBottom, viewportRef } = useMessageScroller()

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    let glideFrame = 0
    let glideTime = 0
    // Last scrollTop the glide wrote. Scroll events at or past it are ours;
    // anything above it means the reader scrolled up.
    let glideTop = -1

    const distanceToBottom = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop

    const stopGlide = () => {
      if (glideFrame) cancelAnimationFrame(glideFrame)
      glideFrame = 0
      glideTop = -1
    }

    const updatePosition = () => {
      setAtBottom(distanceToBottom() <= bottomThreshold)
    }
    const handleScroll = () => {
      if (glideFrame && viewport.scrollTop >= glideTop - 1) return
      stopGlide()
      const atBottom = distanceToBottom() <= bottomThreshold
      followingRef.current = atBottom
      setAtBottom(atBottom)
    }

    // Eases toward the bottom instead of jumping, so streamed text scrolls
    // like a teleprompter. Large gaps (opening a conversation) still jump.
    const glide = (time: number) => {
      const delta = glideTime ? Math.min(time - glideTime, 64) : 16
      glideTime = time
      const target = viewport.scrollHeight - viewport.clientHeight
      const remaining = target - viewport.scrollTop
      if (remaining <= 1) {
        viewport.scrollTop = target
        stopGlide()
        setAtBottom(true)
        return
      }
      const step = Math.max(remaining * (1 - Math.exp(-delta / 90)), 1)
      viewport.scrollTop = viewport.scrollTop + step
      glideTop = viewport.scrollTop
      glideFrame = requestAnimationFrame(glide)
    }

    const followLatest = () => {
      if (!followingRef.current) {
        updatePosition()
        return
      }
      const distance = distanceToBottom()
      if (reduceMotion || distance > viewport.clientHeight * 1.5) {
        stopGlide()
        viewport.scrollTop = viewport.scrollHeight
        setAtBottom(true)
        return
      }
      if (distance <= 1 || glideFrame) return
      glideTime = 0
      glideTop = viewport.scrollTop
      glideFrame = requestAnimationFrame(glide)
    }

    const resizeObserver = new ResizeObserver(followLatest)
    const mutationObserver = new MutationObserver(followLatest)
    resizeObserver.observe(viewport)
    if (viewport.firstElementChild)
      resizeObserver.observe(viewport.firstElementChild)
    mutationObserver.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener("scroll", handleScroll, { passive: true })
    followLatest()

    return () => {
      stopGlide()
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      viewport.removeEventListener("scroll", handleScroll)
    }
  }, [followingRef, setAtBottom, viewportRef])

  return (
    <div
      ref={viewportRef}
      data-slot="message-scroller-viewport"
      role="region"
      aria-label="Messages"
      tabIndex={0}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      aria-relevant="additions"
      className={cn("flex min-h-full flex-col", className)}
      {...props}
    />
  )
}

function MessageScrollerButton({
  className,
  style,
}: {
  className?: string
  style?: React.CSSProperties
}) {
  const { atBottom, scrollToLatest } = useMessageScroller()

  return (
    <Button
      aria-label="Jump to latest message"
      className={cn(
        "absolute right-4 bottom-4 z-10 size-9 rounded-full shadow-lg transition-all",
        atBottom && "pointer-events-none translate-y-2 opacity-0",
        className
      )}
      inert={atBottom ? true : undefined}
      onClick={scrollToLatest}
      size="icon-sm"
      style={style}
      tabIndex={atBottom ? -1 : 0}
      type="button"
      variant="outline"
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}

function useMessageScroller() {
  const context = React.useContext(MessageScrollerContext)
  if (!context) {
    throw new Error(
      "MessageScroller must be used inside MessageScrollerProvider"
    )
  }
  return context
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
}
