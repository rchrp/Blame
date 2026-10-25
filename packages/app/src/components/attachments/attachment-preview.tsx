import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon, PenLineIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { attachmentFormat, hasDocumentPreview } from "./attachment-format"
import { AttachmentIcon } from "./attachment-icon"
import type { ComposerAttachment } from "./attachment-types"
import { DocumentContent } from "./document-content"
import { useDocumentPreview } from "./use-document-preview"
import { useAttachmentActions } from "./use-attachment-actions"

export function AttachmentPreview({
  attachment,
  onOpenImage,
  onOpenDocument,
  onRemove,
}: {
  attachment: ComposerAttachment
  onOpenImage: (id: string) => void
  onOpenDocument: (id: string) => void
  onRemove?: (attachment: ComposerAttachment) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const format = attachmentFormat(attachment.file)
  const isImage = Boolean(attachment.previewUrl)
  const previewable = !isImage && hasDocumentPreview(attachment.file)
  const preview = useDocumentPreview(attachment, visible && previewable)
  const actions = useAttachmentActions(attachment)
  const external = format === "audio" || format === "video"
  useEffect(() => {
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
  }, [])
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
          "relative flex h-40 flex-col overflow-hidden rounded-xl border border-border/70 bg-muted/40 text-left transition-colors outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60",
          isImage ? "w-40" : "w-56"
        )}
      >
        {isImage ? (
          <>
            <img
              alt=""
              className="size-full object-cover"
              loading="lazy"
              src={attachment.previewUrl}
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
            </div>
          </>
        )}
      </button>
      {!isImage && preview.data && (
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
        <button
          type="button"
          aria-label={`Remove ${title}`}
          onClick={() => onRemove(attachment)}
          className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm transition-opacity outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
