import * as React from "react"
import { CornerDownRightIcon } from "lucide-react"
import { MarkdownMessage } from "@/components/backlog/drawer/markdown-editor"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  hasModKey,
  isKeyOwnedByTarget,
  isMac,
  modKeyLabel,
  topDialog,
} from "@/lib/keyboard"
import type { EpicEntry } from "./data/epic-transcript"

export function EpicQuestion({
  question,
  disabled,
  onAnswer,
  editorRef,
}: {
  question: Extract<EpicEntry, { kind: "end" }>
  disabled: boolean
  onAnswer: (answer: string) => void
  editorRef: React.RefObject<HTMLDivElement | null>
}) {
  const primary = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Enter" ||
        !hasModKey(event) ||
        event.altKey ||
        event.shiftKey ||
        (event.ctrlKey && event.metaKey)
      )
        return
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !primary.current ||
        primary.current.disabled ||
        topDialog()
      )
        return
      if (
        isKeyOwnedByTarget(event.target) &&
        !(
          event.target instanceof Node &&
          editorRef.current?.contains(event.target)
        )
      )
        return
      event.preventDefault()
      primary.current.click()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [editorRef])
  return (
    <div className="mt-auto min-w-0 px-2 text-sm sm:px-10">
      <div className="grid gap-2 rounded-xl border border-border/70 px-4 py-3">
        {question.reason && question.reason !== question.question && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {question.reason}
          </p>
        )}
        <MarkdownMessage
          appearance="plain"
          markdown={question.question ?? ""}
        />
        <div
          className="flex flex-wrap items-center gap-1.5 pt-0.5"
          role="group"
          aria-label="Reply to the orchestrator"
        >
          {question.options.map((option, index) => (
            <Button
              key={option}
              ref={index === 0 ? primary : undefined}
              aria-keyshortcuts={
                index === 0
                  ? isMac
                    ? "Meta+Enter"
                    : "Control+Enter"
                  : undefined
              }
              size="sm"
              type="button"
              variant="secondary"
              disabled={disabled}
              className={
                index === 0
                  ? "h-auto min-h-7 bg-foreground whitespace-normal text-background hover:bg-foreground/85"
                  : "h-auto min-h-7 whitespace-normal"
              }
              onClick={() => onAnswer(option)}
            >
              {option}
              {index === 0 && (
                <Kbd
                  aria-hidden="true"
                  className="ml-0.5 h-4 min-w-0 border border-current/15 bg-transparent text-[10px] text-current"
                >
                  {modKeyLabel} ↵
                </Kbd>
              )}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={disabled}
            onClick={() =>
              editorRef.current
                ?.querySelector<HTMLElement>(
                  '[data-markdown-editor-input="true"]'
                )
                ?.focus()
            }
          >
            <CornerDownRightIcon /> Write a reply
          </Button>
        </div>
      </div>
    </div>
  )
}
