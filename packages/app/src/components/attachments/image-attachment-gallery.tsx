import * as React from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  PencilIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { AnnotationCanvas } from "./annotation-canvas"
import { AnnotationToolbar, toolShortcuts } from "./annotation-toolbar"
import {
  annotatedFileName,
  commitAnnotations,
  createHistory,
  redoAnnotations,
  undoAnnotations,
  type Annotation,
  type AnnotationHistory,
  type AnnotationTool,
  type Point,
} from "./annotation-model"
import { renderAnnotatedImage } from "./annotation-renderer"

export type ImageAnnotation = { source: string; marks: Annotation[] }
export type GalleryImage = {
  id: string
  name: string
  source: string
  annotation?: ImageAnnotation
}
export type AnnotatedAttachment = {
  id: string
  file: File
  annotation: ImageAnnotation
}
type TextDraft = { point: Point; value: string; mark?: Annotation }

// A session owns all image histories. Switching slides never commits or loses edits.
export function ImageAttachmentGallery({
  images,
  initialId,
  onClose,
  onSave,
}: {
  images: GalleryImage[]
  initialId: string
  onClose: () => void
  onSave?: (changes: AnnotatedAttachment[]) => Promise<void>
}) {
  const [index, setIndex] = React.useState(() =>
    Math.max(
      0,
      images.findIndex((image) => image.id === initialId)
    )
  )
  const [histories, setHistories] = React.useState<
    Record<string, AnnotationHistory>
  >(() =>
    Object.fromEntries(
      images.map((image) => [image.id, createHistory(image.annotation?.marks)])
    )
  )
  const [tool, setTool] = React.useState<AnnotationTool>("pen")
  const [color, setColor] = React.useState("#ef4444")
  const [width, setWidth] = React.useState(3)
  const [editing, setEditing] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [textDraft, setTextDraft] = React.useState<TextDraft | null>(null)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const opener = React.useRef(document.activeElement as HTMLElement | null)
  const current = images[Math.min(index, images.length - 1)]
  const history =
    histories[current.id] ?? createHistory(current.annotation?.marks)
  const changed = images.filter(
    (image) =>
      JSON.stringify(histories[image.id]?.present ?? []) !==
      JSON.stringify(image.annotation?.marks ?? [])
  )
  const locked = saving || Boolean(textDraft) || confirmDiscard
  function update(next: AnnotationHistory) {
    setHistories((all) => ({ ...all, [current.id]: next }))
  }
  function step(delta: number) {
    if (locked) return
    const next = Math.max(0, Math.min(images.length - 1, index + delta))
    if (next === index) return
    setIndex(next)
    setSelected(null)
    setReady(false)
    setError(null)
  }
  function requestClose() {
    if (saving) return
    if (textDraft) {
      setTextDraft(null)
      return
    }
    if (changed.length) setConfirmDiscard(true)
    else onClose()
  }
  function undo() {
    update(undoAnnotations(history))
    setSelected(null)
  }
  function redo() {
    update(redoAnnotations(history))
    setSelected(null)
  }
  function removeSelected() {
    update(
      commitAnnotations(
        history,
        history.present.filter((mark) => mark.id !== selected)
      )
    )
    setSelected(null)
  }
  function changeStyle(style: Partial<Pick<Annotation, "color" | "width">>) {
    if (style.color) setColor(style.color)
    if (style.width) setWidth(style.width)
    if (selected)
      update(
        commitAnnotations(
          history,
          history.present.map((mark) =>
            mark.id === selected ? { ...mark, ...style } : mark
          )
        )
      )
  }
  async function save() {
    if (!onSave || saving) return
    setSaving(true)
    setError(null)
    try {
      // Finish every export before mutating the composer; an error leaves all drafts intact.
      const changes: AnnotatedAttachment[] = []
      for (const image of changed) {
        const annotation = {
          source: image.annotation?.source ?? image.source,
          marks: histories[image.id].present,
        }
        const blob = await renderAnnotatedImage(
          annotation.source,
          annotation.marks
        )
        changes.push({
          id: image.id,
          file: new File([blob], annotatedFileName(image.name), {
            type: "image/png",
          }),
          annotation,
        })
      }
      await onSave(changes)
      onClose()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The images could not be saved. Your annotations are still here; try again."
      )
    } finally {
      setSaving(false)
    }
  }
  function keyDown(event: React.KeyboardEvent) {
    // The dialog is rendered through a portal inside a composer: keep its shortcuts local.
    event.stopPropagation()
    const target = event.target as HTMLElement
    if (
      target.closest(
        "input, textarea, [contenteditable=true], [data-slot=popover-content]"
      ) ||
      locked
    )
      return
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (command && key === "s" && onSave && changed.length) {
      event.preventDefault()
      void save()
      return
    }
    if (command && editing && (key === "z" || key === "y")) {
      event.preventDefault()
      if (event.shiftKey || key === "y") redo()
      else undo()
      return
    }
    if (command || event.altKey) return
    if (key === "arrowleft" || key === "arrowright") {
      event.preventDefault()
      step(key === "arrowleft" ? -1 : 1)
    } else if (
      editing &&
      (key === "delete" || key === "backspace") &&
      selected
    ) {
      event.preventDefault()
      removeSelected()
    } else if (onSave && toolShortcuts[key]) {
      event.preventDefault()
      setEditing(true)
      setTool(toolShortcuts[key])
      setSelected(null)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1rem)] max-h-[1000px] w-[calc(100%-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100%-3rem)] sm:max-w-[1440px]"
        onKeyDown={keyDown}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (confirmDiscard) setConfirmDiscard(false)
          else requestClose()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          opener.current?.focus()
        }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <DialogTitle
              className="truncate text-sm leading-5"
              title={current.name}
            >
              {current.name}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              {editing
                ? "Annotate your image, then apply your changes."
                : "Image attachment"}
            </DialogDescription>
          </div>
          {images.length > 1 && (
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              aria-live="polite"
            >
              {index + 1} / {images.length}
            </span>
          )}
          {onSave && !editing && (
            <Button
              type="button"
              variant="secondary"
              disabled={!ready}
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
              Annotate
            </Button>
          )}
          {onSave && editing && (
            <Button
              type="button"
              disabled={!changed.length || locked}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {saving ? "Saving…" : "Apply changes"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Close image viewer"
            disabled={saving}
            onClick={requestClose}
          >
            <XIcon />
          </Button>
        </header>
        {error && (
          <div
            role="alert"
            className="shrink-0 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        {confirmDiscard && (
          <div
            role="alertdialog"
            aria-label="Discard annotations?"
            aria-describedby="discard-annotations-description"
            className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-muted px-4 py-3"
          >
            <p id="discard-annotations-description" className="text-sm">
              Discard your unsaved annotations?
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </Button>
              <Button type="button" variant="destructive" onClick={onClose}>
                Discard changes
              </Button>
            </div>
          </div>
        )}
        <div className="relative min-h-0 flex-1 bg-muted/40 p-3 sm:px-16 sm:py-6">
          <AnnotationCanvas
            key={current.id}
            source={current.annotation?.source ?? current.source}
            name={current.name}
            marks={history.present}
            tool={tool}
            color={color}
            width={width}
            selected={selected}
            disabled={!editing || locked}
            onReady={setReady}
            onSelect={setSelected}
            onChange={(marks) => update(commitAnnotations(history, marks))}
            onText={(point, mark) =>
              setTextDraft({ point, value: mark?.text ?? "", mark })
            }
          />
          {images.length > 1 && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label="Previous image (Left arrow)"
                disabled={index === 0 || locked}
                className="absolute top-1/2 left-1 size-10 -translate-y-1/2 shadow-md sm:left-3"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label="Next image (Right arrow)"
                disabled={index === images.length - 1 || locked}
                className="absolute top-1/2 right-1 size-10 -translate-y-1/2 shadow-md sm:right-3"
                onClick={() => step(1)}
              >
                <ChevronRightIcon />
              </Button>
            </>
          )}
          {textDraft && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 p-4">
              <form
                aria-label="Annotation text"
                className="w-full max-w-sm space-y-3 rounded-xl bg-popover p-4 shadow-lg"
                onSubmit={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!textDraft.value.trim()) return
                  const mark: Annotation = {
                    id: textDraft.mark?.id ?? crypto.randomUUID(),
                    kind: "text",
                    color: textDraft.mark?.color ?? color,
                    width: textDraft.mark?.width ?? width,
                    points: [textDraft.point],
                    text: textDraft.value.trim(),
                  }
                  const next = textDraft.mark
                    ? history.present.map((existing) =>
                        existing.id === mark.id ? mark : existing
                      )
                    : [...history.present, mark]
                  update(commitAnnotations(history, next))
                  setTextDraft(null)
                  setSelected(mark.id)
                  setTool("select")
                }}
              >
                <label
                  htmlFor="image-annotation-text"
                  className="text-sm font-medium"
                >
                  {textDraft.mark ? "Edit text" : "Add text"}
                </label>
                <textarea
                  id="image-annotation-text"
                  autoFocus
                  rows={3}
                  maxLength={1000}
                  placeholder="Type your annotation…"
                  value={textDraft.value}
                  onChange={(event) =>
                    setTextDraft({ ...textDraft, value: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setTextDraft(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!textDraft.value.trim()}>
                    {textDraft.mark ? "Update text" : "Add text"}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
        <footer className="flex shrink-0 flex-col items-center gap-2 border-t bg-muted/40 px-2 py-3 sm:px-4">
          {editing && onSave && (
            <AnnotationToolbar
              tool={tool}
              color={color}
              width={width}
              onTool={(value) => {
                setTool(value)
                setSelected(null)
              }}
              onColor={(value) => changeStyle({ color: value })}
              onWidth={(value) => changeStyle({ width: value })}
              onUndo={undo}
              onRedo={redo}
              onDelete={removeSelected}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              selected={Boolean(selected)}
              disabled={!ready || locked}
            />
          )}
          <p
            aria-live="polite"
            className="text-center text-xs text-muted-foreground"
          >
            {changed.length
              ? `${changed.length} image${changed.length > 1 ? "s" : ""} with unsaved annotations`
              : editing
                ? tool === "text"
                  ? "Click the image to add text."
                  : tool === "select"
                    ? "Drag to move. Double-click text to edit."
                    : tool === "eraser"
                      ? "Click or drag over an annotation to erase it."
                      : "Draw directly on the image."
                : images.length > 1
                  ? "Use ← and → to browse images. Esc to close."
                  : "Esc to close."}
          </p>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
