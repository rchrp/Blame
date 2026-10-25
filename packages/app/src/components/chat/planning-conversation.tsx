import * as React from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { cn } from "@/lib/utils"

const headerSoftBlurMask = {
  maskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties
const headerStrongBlurMask = {
  maskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 72%)",
} satisfies React.CSSProperties
const footerBlurMask = {
  maskImage: "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
  WebkitMaskImage:
    "linear-gradient(to top, black 0%, black 60%, transparent 100%)",
} satisfies React.CSSProperties

/** Shared conversation surface for backlog planning and new-project guidance. */
export function PlanningConversation({
  open,
  empty,
  label,
  title,
  description,
  actions,
  footer,
  children,
  onOpenAutoFocus,
  onInteractOutside,
}: {
  open: boolean
  empty: boolean
  label: string
  title: React.ReactNode
  description: string
  actions?: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
  onOpenAutoFocus?: React.ComponentProps<
    typeof DialogContent
  >["onOpenAutoFocus"]
  onInteractOutside?: React.ComponentProps<
    typeof DialogContent
  >["onInteractOutside"]
}) {
  const [footerElement, setFooterElement] = React.useState<HTMLElement | null>(
    null
  )
  const footerHeight = useElementHeight(footerElement, open)
  return (
    <DialogContent
      showCloseButton={false}
      className="block h-[min(54rem,calc(100svh-3rem))] overflow-hidden p-0 sm:max-w-3xl"
      onOpenAutoFocus={onOpenAutoFocus}
      onInteractOutside={onInteractOutside}
    >
      <MessageScrollerProvider>
        <MessageScroller className="h-full">
          <MessageScrollerViewport aria-label={label}>
            <MessageScrollerContent
              className={cn(
                "mx-auto grid w-full max-w-2xl gap-6 px-6 pt-24",
                empty ? "content-center" : "content-start"
              )}
              style={{ paddingBottom: footerHeight + 24 }}
            >
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            className="right-6 z-30"
            style={{ bottom: footerHeight + 16 }}
          />
        </MessageScroller>
      </MessageScrollerProvider>
      <header className="absolute inset-x-0 top-0 isolate z-20 flex items-center gap-3 px-6 pt-5 pb-8">
        <div
          className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-sm"
          style={headerSoftBlurMask}
        />
        <div
          className="absolute inset-0 -z-10 bg-popover/20 backdrop-blur-2xl backdrop-saturate-150"
          style={headerStrongBlurMask}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <DialogTitle className="flex items-center gap-2 font-heading text-xl leading-tight font-semibold">
            {title}
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {description}
          </DialogDescription>
        </div>
        {actions}
        <DialogClose asChild>
          <Button
            className="border bg-background/90 shadow-sm"
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </DialogClose>
      </header>
      <footer
        ref={setFooterElement}
        className="absolute inset-x-0 bottom-0 z-20 px-6 pt-6 pb-5"
      >
        <div
          className="pointer-events-none absolute inset-0 bg-background/40 backdrop-blur-xl"
          style={footerBlurMask}
        />
        <div className="relative mx-auto grid w-full max-w-2xl min-w-0 grid-cols-1 gap-2">
          {footer}
        </div>
      </footer>
    </DialogContent>
  )
}

// The floating composer's height, so the conversation can scroll clear of it.
function useElementHeight(element: HTMLElement | null, active: boolean) {
  const [height, setHeight] = React.useState(160)
  React.useLayoutEffect(() => {
    if (!element || !active) return
    const update = () => {
      const next = Math.ceil(element.getBoundingClientRect().height)
      setHeight((current) => (current === next ? current : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, element])
  return height
}
