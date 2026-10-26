import { lazy, Suspense, useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { attachmentFormat, hasDocumentPreview } from "./attachment-format"
import { AttachmentIcon } from "./attachment-icon"
import type { ComposerAttachment } from "./attachment-types"
import { DocumentContent } from "./document-content"
import { useDocumentPreview } from "./use-document-preview"
import { useAttachmentActions } from "./use-attachment-actions"

import { useGalleryBackdrop } from "./use-gallery-backdrop"

const PdfDocument = lazy(() => import("./pdf-document"))

export function DocumentAttachmentGallery({
  attachments,
  initialId,
  onClose,
  onRestoreFocus,
}: {
  attachments: ComposerAttachment[]
  initialId: string
  onClose: () => void
  onRestoreFocus: (id: string) => void
}) {
  const backdrop = useGalleryBackdrop(onClose)
  const [id, setId] = useState(initialId)
  const index = Math.max(
    0,
    attachments.findIndex((item) => item.id === id)
  )
  const attachment = attachments[index]
  if (!attachment) return null
  const navigate = (offset: number) => {
    const next = attachments[index + offset]
    if (next) setId(next.id)
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        {...backdrop}
        showCloseButton={false}
        overlayClassName="bg-background/55 backdrop-blur-xl supports-backdrop-filter:backdrop-blur-xl"
        className="fixed inset-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-transparent px-3 py-4 ring-0 sm:max-w-none sm:px-16 sm:py-6"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus(attachment.id)
        }}
        onKeyDown={(event) => {
          if (
            event.altKey ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            /INPUT|SELECT|TEXTAREA/.test((event.target as HTMLElement).tagName)
          )
            return
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            navigate(-1)
          }
          if (event.key === "ArrowRight") {
            event.preventDefault()
            navigate(1)
          }
        }}
      >
        <DialogTitle className="sr-only">
          Preview {attachment.file.name}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Read the attachment. Use left and right arrows to switch files, or
          Escape to close.
        </DialogDescription>
        <DocumentView
          key={attachment.id}
          attachment={attachment}
          onClose={onClose}
        />
        {attachments.length > 1 && (
          <div className="pointer-events-none mt-2 flex items-center justify-center gap-3 sm:absolute sm:inset-x-3 sm:top-1/2 sm:mt-0 sm:-translate-y-1/2 sm:justify-between">
            <Button
              className="pointer-events-auto rounded-full bg-popover/90 shadow-md backdrop-blur-xl"
              variant="secondary"
              size="icon"
              aria-label="Previous file"
              disabled={index === 0}
              onClick={() => navigate(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums sm:hidden">
              {index + 1} / {attachments.length}
            </span>
            <Button
              className="pointer-events-auto rounded-full bg-popover/90 shadow-md backdrop-blur-xl"
              variant="secondary"
              size="icon"
              aria-label="Next file"
              disabled={index === attachments.length - 1}
              onClick={() => navigate(1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        )}
        {attachments.length > 1 && (
          <span
            aria-live="polite"
            className="pointer-events-none mt-2 hidden text-center text-xs text-muted-foreground tabular-nums sm:block"
          >
            {index + 1} / {attachments.length}
          </span>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DocumentView({
  attachment,
  onClose,
}: {
  attachment: ComposerAttachment
  onClose: () => void
}) {
  const previewable = hasDocumentPreview(attachment.file)
  const isPdf = attachmentFormat(attachment.file) === "pdf"
  const { data, error, retry } = useDocumentPreview(
    attachment,
    previewable && !isPdf
  )
  const actions = useAttachmentActions(attachment)
  const controls = (
    <div className="flex items-center gap-1 rounded-xl bg-popover/85 p-1.5 shadow-lg backdrop-blur-xl">
      {actions.canOpen && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open in default app"
          title="Open in default app"
          disabled={actions.busy}
          onClick={() => void actions.open()}
        >
          <ExternalLinkIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Download file"
        title="Download file"
        disabled={actions.busy}
        onClick={() => void actions.download()}
      >
        <DownloadIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close preview"
        title="Close preview (Escape)"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  )
  if (isPdf)
    return (
      <Suspense fallback={<LoadingPreview />}>
        <PdfDocument attachment={attachment} actions={controls} />
      </Suspense>
    )
  return (
    <>
      <div data-gallery-backdrop className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {data ? (
          <div className="mx-auto min-h-full w-full max-w-4xl bg-white shadow-lg">
            <DocumentContent data={data} />
            {"truncated" in data && data.truncated && (
              <p className="border-t border-slate-200 p-4 text-sm text-slate-600">
                Preview shortened for large documents. Download the original for
                the complete content.
              </p>
            )}
            {attachmentFormat(attachment.file) === "latex" && (
              <p className="border-t border-slate-200 p-4 text-xs text-slate-600">
                LaTeX source · This preview does not compile the document.
              </p>
            )}
          </div>
        ) : error || !previewable ? (
          <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-4 text-center">
            <AttachmentIcon
              format={attachmentFormat(attachment.file)}
              className="size-12"
            />
            <p className="text-sm" role={error ? "alert" : undefined}>
              {error ??
                "No preview is available for this format. Open or download the original."}
            </p>
            {error && (
              <Button variant="secondary" onClick={retry}>
                Retry preview
              </Button>
            )}
          </div>
        ) : (
          <LoadingPreview />
        )}
      </div>
      <div data-gallery-backdrop className="flex justify-center pt-3">{controls}</div>
    </>
  )
}

function LoadingPreview() {
  return (
    <div
      role="status"
      className="flex h-full flex-1 items-center justify-center"
    >
      <LoaderCircleIcon className="size-6 animate-spin motion-reduce:animate-none" />
      <span className="sr-only">Loading document</span>
    </div>
  )
}
