import * as React from "react"

import type { CodeSelectionAttachment } from "@/components/backlog/shared/comment-attachment-events"
import {
  startChatWithExcerpt,
  startUserStoryWithExcerpt,
} from "@/components/backlog/shared/excerpt-actions"
import {
  excerptActionLabels,
  excerptActions,
  type ExcerptAction,
} from "@/components/backlog/shared/excerpt-model"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

type ExcerptTarget = {
  // Where "Attach as context" puts an excerpt; the action is hidden without it.
  attachAsContext?: (excerpt: CodeSelectionAttachment) => void
}

export type TextSelection = {
  range: Range
  text: string
}

type SelectionAnchor = {
  contextElement: Element
  getBoundingClientRect: () => DOMRect
}

type SelectedExcerpt = {
  anchor: SelectionAnchor
  excerpt: CodeSelectionAttachment
}

// Chromium resolves a selection inside an open shadow root only through
// the composed ranges of that root.
type ComposedSelection = Selection & {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[]
}

const ExcerptTargetContext = React.createContext<ExcerptTarget>({})

export function ExcerptTargetProvider({
  attachAsContext,
  children,
}: ExcerptTarget & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ attachAsContext }), [attachAsContext])
  return (
    <ExcerptTargetContext.Provider value={value}>
      {children}
    </ExcerptTargetContext.Provider>
  )
}

// Text selected in the container gets a bar above it: attach it to the
// current story or chat, or start a new one with it.
export function SelectionExcerptActions({
  containerRef,
  readExcerpt,
  shadowHostSelector,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  readExcerpt: (selection: TextSelection) => CodeSelectionAttachment | undefined
  // Hosts whose open shadow roots hold selectable text.
  shadowHostSelector?: string
}) {
  const { attachAsContext } = React.useContext(ExcerptTargetContext)
  const barRef = React.useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useSelectedExcerpt({
    barRef,
    containerRef,
    readExcerpt,
    shadowHostSelector,
  })
  // Radix positions the bar from this stand-in for the selected text.
  const virtualAnchor = React.useMemo(
    () => ({ current: selected?.anchor ?? null }),
    [selected]
  )
  const actions = excerptActions(Boolean(attachAsContext))

  function runAction(action: ExcerptAction) {
    if (!selected) return
    setSelected(undefined)
    document.getSelection()?.removeAllRanges()
    if (action === "attach-as-context") attachAsContext?.(selected.excerpt)
    else if (action === "new-user-story")
      startUserStoryWithExcerpt(selected.excerpt)
    else startChatWithExcerpt(selected.excerpt)
  }

  return (
    <Popover
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open) setSelected(undefined)
      }}
    >
      {selected ? <PopoverAnchor virtualRef={virtualAnchor} /> : null}
      <PopoverContent
        ref={barRef}
        aria-label="Selection actions"
        role="toolbar"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        hideWhenDetached
        className="w-auto flex-row items-center gap-0.5 rounded-xl p-1 shadow-lg"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Keeps the selection while an action is pressed.
        onMouseDown={(event) => event.preventDefault()}
      >
        {actions.map((action, index) => (
          <React.Fragment key={action}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="h-4 w-px shrink-0 bg-border"
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg px-3 font-normal"
              onClick={() => runAction(action)}
            >
              {excerptActionLabels[action]}
            </Button>
          </React.Fragment>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function nodeElement(node: Node) {
  return node instanceof Element ? node : node.parentElement
}

// Follows the selection once it settles: hidden while the pointer drags,
// shown when the selection inside the container yields an excerpt.
function useSelectedExcerpt({
  barRef,
  containerRef,
  readExcerpt,
  shadowHostSelector,
}: {
  barRef: React.RefObject<HTMLElement | null>
  containerRef: React.RefObject<HTMLElement | null>
  readExcerpt: (selection: TextSelection) => CodeSelectionAttachment | undefined
  shadowHostSelector?: string
}) {
  const [selected, setSelected] = React.useState<SelectedExcerpt>()
  const readExcerptRef = React.useRef(readExcerpt)

  React.useEffect(() => {
    readExcerptRef.current = readExcerpt
  }, [readExcerpt])

  React.useEffect(() => {
    let frame = 0
    let selecting = false
    const readSelection = () => {
      const container = containerRef.current
      const selection =
        container && !selecting
          ? containedSelection(container, shadowHostSelector)
          : undefined
      const excerpt = selection ? readExcerptRef.current(selection) : undefined
      setSelected(
        container && selection && excerpt
          ? {
              anchor: {
                contextElement: container,
                getBoundingClientRect: () =>
                  selection.range.getBoundingClientRect(),
              },
              excerpt,
            }
          : undefined
      )
    }
    const scheduleRead = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(readSelection)
    }
    const startSelecting = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (
        event.target instanceof Node &&
        barRef.current?.contains(event.target)
      )
        return
      selecting = true
      cancelAnimationFrame(frame)
      setSelected(undefined)
    }
    const finishSelecting = () => {
      if (!selecting) return
      selecting = false
      scheduleRead()
    }
    document.addEventListener("selectionchange", scheduleRead)
    document.addEventListener("pointerdown", startSelecting, true)
    document.addEventListener("pointerup", finishSelecting, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("selectionchange", scheduleRead)
      document.removeEventListener("pointerdown", startSelecting, true)
      document.removeEventListener("pointerup", finishSelecting, true)
    }
  }, [barRef, containerRef, shadowHostSelector])

  return [selected, setSelected] as const
}

function containedSelection(
  container: HTMLElement,
  shadowHostSelector: string | undefined
): TextSelection | undefined {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0) return undefined
  const range = selectedRange(
    selection,
    shadowRoots(container, shadowHostSelector)
  )
  if (
    !range ||
    range.collapsed ||
    !composedContains(container, range.startContainer) ||
    !composedContains(container, range.endContainer)
  ) {
    return undefined
  }
  const text = selection.toString() || range.toString()
  return text.trim() ? { range, text } : undefined
}

function selectedRange(selection: ComposedSelection, roots: ShadowRoot[]) {
  if (roots.length === 0 || !selection.getComposedRanges) {
    return selection.getRangeAt(0)
  }
  const [composed] = selection.getComposedRanges({ shadowRoots: roots })
  if (!composed) return undefined
  const range = document.createRange()
  range.setStart(composed.startContainer, composed.startOffset)
  range.setEnd(composed.endContainer, composed.endOffset)
  return range
}

function shadowRoots(container: HTMLElement, hostSelector: string | undefined) {
  if (!hostSelector) return []
  return Array.from(container.querySelectorAll(hostSelector)).flatMap((host) =>
    host.shadowRoot ? [host.shadowRoot] : []
  )
}

function composedContains(container: Node, node: Node) {
  let current: Node | null = node
  while (current) {
    if (current === container) return true
    current = current instanceof ShadowRoot ? current.host : current.parentNode
  }
  return false
}
