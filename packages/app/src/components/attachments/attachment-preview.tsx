import { useEffect, useRef, useState } from "react"
import {
  ArrowUpRightIcon,
  LoaderCircleIcon,
  PenLineIcon,
  Table2Icon,
  XIcon,
} from "lucide-react"
import { selectBacklogStory } from "@/components/backlog/data/backlog-navigation"
import {
  navigate,
  navigationPathname,
} from "@/components/navigation/navigation"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { attachmentFormat, hasDocumentPreview } from "./attachment-format"
import { AttachmentIcon } from "./attachment-icon"
import type { ComposerAttachment } from "./attachment-types"
import { DocumentContent } from "./document-content"
import { useDocumentPreview } from "./use-document-preview"
import { useAttachmentActions } from "./use-attachment-actions"
import { useAttachmentImageUrl } from "./use-stored-attachment-url"

type AttachmentPreviewProps = {
  attachment: ComposerAttachment
  compact?: boolean
  onOpenImage: (id: string) => void
  onOpenDocument: (id: string) => void
  onRemove?: (attachment: ComposerAttachment) => void
}

export function AttachmentPreview(props: AttachmentPreviewProps) {
  if (props.attachment.source === "story") {
    return (
      <StoryAttachmentPreview
        attachment={props.attachment}
        compact={props.compact}
        onRemove={props.onRemove}
      />
    )
  }
  return <FileAttachmentPreview {...props} />
}

function FileAttachmentPreview({
  attachment,
  compact = false,
  onOpenImage,
  onOpenDocument,
  onRemove,
}: AttachmentPreviewProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const format = attachmentFormat(attachment.file)
  const isImage = Boolean(attachment.previewUrl)
  const previewable = !isImage && hasDocumentPreview(attachment.file)
  const preview = useDocumentPreview(
    attachment,
    !compact && visible && previewable
  )
  const actions = useAttachmentActions(attachment)
  const image = useAttachmentImageUrl(attachment)
  const external = format === "audio" || format === "video"
  useEffect(() => {
    if (compact) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "80px" }
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [compact])
  const title = attachment.title ?? attachment.file.name
  return (
    <div ref={ref} className="group relative shrink-0">
      <button
        type="button"
        data-image-attachment-id={isImage ? attachment.id : undefined}
        data-document-attachment-id={isImage ? undefined : attachment.id}
        title={`${title}${attachment.subtitle ? ` · ${attachment.subtitle}` : ""}`}
        aria-label={`${external ? (actions.canOpen ? "Open in default app:" : "Download") : "Preview"} ${title}`}
        aria-busy={actions.busy}
        disabled={actions.busy}
        onClick={() =>
          isImage
            ? onOpenImage(attachment.id)
            : external
              ? void actions.open()
              : onOpenDocument(attachment.id)
        }
        className={cn(
          "relative flex overflow-hidden rounded-xl border border-border/70 bg-muted/40 text-left transition-colors outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60",
          compact
            ? "h-12 max-w-56 items-center gap-2 pr-8 pl-2"
            : cn("h-40 flex-col", isImage ? "w-40" : "w-56")
        )}
      >
        {compact ? (
          <>
            {isImage ? (
              <img
                alt=""
                className="size-8 shrink-0 rounded-md object-cover"
                loading="lazy"
                src={image.url}
                onError={image.onError}
              />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/5">
                <AttachmentIcon format={format} />
              </span>
            )}
            <span className="min-w-0 truncate text-xs font-medium">
              {title}
            </span>
            {attachment.annotation && (
              <PenLineIcon
                aria-label="Annotated"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
          </>
        ) : isImage ? (
          <>
            <img
              alt=""
              className="size-full object-cover"
              loading="lazy"
              src={image.url}
              onError={image.onError}
            />
            {attachment.annotation && (
              <span
                className="absolute right-2 bottom-2 rounded-md bg-background/90 p-1"
                title="Annotated"
              >
                <PenLineIcon className="size-3" />
              </span>
            )}
          </>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="relative min-h-0 w-full flex-1 overflow-hidden bg-muted/40"
            >
              {!preview.data && (
                <div className="flex h-full flex-col items-center justify-center gap-2">
                  {previewable && !preview.error ? (
                    <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
                  ) : (
                    <AttachmentIcon
                      format={format}
                      className="size-10 opacity-65"
                    />
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {preview.error
                      ? "Preview unavailable"
                      : previewable
                        ? "Loading preview…"
                        : external
                          ? actions.canOpen
                            ? "Open in default app"
                            : "Download file"
                          : "Open file"}
                  </span>
                </div>
              )}
            </div>
            <div className="flex h-10 w-full shrink-0 items-center gap-2 bg-background/85 px-3">
              <AttachmentIcon format={format} />
              <span className="truncate text-xs font-medium">{title}</span>
              {attachment.source === "code" ? (
                <Badge
                  variant="secondary"
                  className="ml-auto h-5 shrink-0 px-1.5 text-[10px]"
                >
                  Excerpt
                </Badge>
              ) : null}
            </div>
          </>
        )}
      </button>
      {!compact && !isImage && preview.data && (
        <div
          inert
          aria-hidden="true"
          className="pointer-events-none absolute top-px left-px h-[118px] w-[222px] overflow-hidden rounded-t-[11px] bg-white"
        >
          <div
            className="origin-top-left"
            style={{ width: "200%", height: "200%", transform: "scale(.5)" }}
          >
            <DocumentContent data={preview.data} thumbnail />
          </div>
        </div>
      )}
      {onRemove && (
        <RemoveAttachmentButton
          compact={compact}
          title={title}
          onRemove={() => onRemove(attachment)}
        />
      )}
    </div>
  )
}

// A story attached as context: it opens the story, it has no preview.
function StoryAttachmentPreview({
  attachment,
  compact = false,
  onRemove,
}: Pick<AttachmentPreviewProps, "attachment" | "compact" | "onRemove">) {
  const displayId = attachment.title ?? attachment.file.name
  const storyTitle = attachment.subtitle
  const label = storyTitle ? `${displayId} · ${storyTitle}` : displayId
  const { storyId } = attachment
  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        title={label}
        aria-label={`Open ${label}`}
        disabled={!storyId}
        onClick={() => {
          if (storyId) openBacklogStory(storyId)
        }}
        className={cn(
          "relative flex overflow-hidden rounded-xl border border-border/70 bg-muted/40 text-left transition-colors outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60",
          compact
            ? "h-12 max-w-56 items-center gap-2 pr-8 pl-2"
            : "h-40 w-56 flex-col"
        )}
      >
        {compact ? (
          <>
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/5 text-muted-foreground">
              <Table2Icon className="size-4" />
            </span>
            <span className="min-w-0 truncate text-xs font-medium">
              {storyTitle ?? displayId}
            </span>
          </>
        ) : (
          <>
            <div className="flex min-h-0 w-full flex-1 flex-col gap-2 p-3">
              <span className="line-clamp-4 text-sm leading-5 font-medium text-foreground">
                {storyTitle ?? displayId}
              </span>
              <span className="mt-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                Open the story
                <ArrowUpRightIcon className="size-3" />
              </span>
            </div>
            <div className="flex h-10 w-full shrink-0 items-center gap-2 bg-background/85 px-3">
              <Table2Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs font-medium">
                {displayId}
              </span>
              <Badge
                variant="secondary"
                className="ml-auto h-5 shrink-0 px-1.5 text-[10px]"
              >
                Context
              </Badge>
            </div>
          </>
        )}
      </button>
      {onRemove && (
        <RemoveAttachmentButton
          compact={compact}
          title={displayId}
          onRemove={() => onRemove(attachment)}
        />
      )}
    </div>
  )
}

function RemoveAttachmentButton({
  compact,
  onRemove,
  title,
}: {
  compact: boolean
  onRemove: () => void
  title: string
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${title}`}
      onClick={onRemove}
      className={cn(
        "absolute flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact
          ? "top-1/2 right-1.5 size-5 -translate-y-1/2 text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
          : "top-1.5 right-1.5 size-7 bg-background/95 text-foreground shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0"
      )}
    >
      <XIcon className="size-3.5" />
    </button>
  )
}

// From any page: the backlog opens the story in its drawer.
function openBacklogStory(storyId: string) {
  if (navigationPathname() !== "/backlog") navigate("/backlog")
  selectBacklogStory(storyId)
}
