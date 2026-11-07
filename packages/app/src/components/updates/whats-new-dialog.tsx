import * as React from "react"
import { ArrowUpRightIcon, SparklesIcon, XIcon } from "lucide-react"

import { MarkdownPreview } from "@/components/backlog/drawer/markdown-preview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { usePlatform } from "@/context/platform"
import type { ReleaseNotes } from "@/context/platform-whats-new"
import { publicAssetUrl } from "@/lib/public-asset-url"
import { cn } from "@/lib/utils"
import { releaseNotesView, releasePageUrl } from "./release-notes"
import "./whats-new-dialog.css"

// Shows the notes of the version Blame updated to, once, after the update.
export function WhatsNewOnLaunch({ enabled = true }: { enabled?: boolean }) {
  const { whatsNew } = usePlatform()
  const client = enabled ? whatsNew : undefined
  const [notes, setNotes] = React.useState<ReleaseNotes | null>(null)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    if (!client) return undefined
    let active = true
    const show = (next: ReleaseNotes | null) => {
      if (!active || !next) return
      setNotes(next)
      setOpen(true)
      // Seen once shown: quitting with the screen open never shows it again.
      client.dismiss(next.version).catch((error: unknown) => {
        console.warn("Could not record that What's new was shown", error)
      })
    }
    const unsubscribe = client.onAvailable(show)
    client.pending().then(show, () => {
      /* The update check can still bring the notes with whats-new:available. */
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [client])

  if (!notes) return null
  return (
    <WhatsNewDialog
      notes={notes}
      open={open}
      showImages
      onOpenChange={setOpen}
    />
  )
}

export function WhatsNewDialog({
  notes,
  onOpenChange,
  open,
  showImages,
}: {
  notes: ReleaseNotes
  onOpenChange(open: boolean): void
  open: boolean
  // Off while update checks are off: the cover would be a request of its own.
  showImages: boolean
}) {
  const platform = usePlatform()
  const view = React.useMemo(() => releaseNotesView(notes.notes), [notes.notes])
  const [failedCover, setFailedCover] = React.useState<string>()
  const cover =
    showImages && view.cover?.url !== failedCover ? view.cover : undefined
  const released = releaseDateLabel(notes.releaseDate)

  function openLink(url: string) {
    if (platform.openExternalLink) platform.openExternalLink(url)
    else window.open(url, "_blank", "noopener,noreferrer")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(88vh,48rem)] flex-col gap-0 overflow-hidden rounded-3xl p-0 shadow-2xl sm:max-w-2xl"
      >
        <header
          className={cn(
            "relative isolate flex shrink-0 flex-col justify-end gap-3 overflow-hidden px-8 pt-14 pb-7 text-white",
            cover ? "min-h-72" : "min-h-56"
          )}
        >
          {cover ? (
            <img
              alt={cover.alt}
              className="whats-new-cover absolute inset-0 -z-20 size-full object-cover"
              referrerPolicy="no-referrer"
              src={cover.url}
              onError={() => setFailedCover(cover.url)}
            />
          ) : (
            <img
              alt=""
              aria-hidden
              className="whats-new-cover absolute inset-0 -z-20 size-full object-cover object-[50%_40%]"
              src={publicAssetUrl("whats-new-cover.jpg")}
            />
          )}
          <div
            aria-hidden
            className="absolute inset-0 -z-10 bg-linear-to-t from-black/80 via-black/35 to-black/0"
          />
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4 rounded-full bg-black/25 text-white backdrop-blur-sm hover:bg-black/45 hover:text-white"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
          <span
            aria-hidden
            className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium ring-1 ring-white/25 backdrop-blur-sm"
          >
            <SparklesIcon className="size-3.5" />
            What's new in Blame
          </span>
          <DialogTitle className="text-5xl leading-none font-bold tracking-tight text-balance drop-shadow-sm">
            <span className="sr-only">What's new in Blame </span>v
            {notes.version}
          </DialogTitle>
          <DialogDescription className="text-white/75">
            {released ?? "Here is what changed in this version."}
          </DialogDescription>
        </header>
        {/* Links open in the browser, never in the app window. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 py-6"
          onClickCapture={(event) => {
            const link = (event.target as HTMLElement).closest("a")
            if (!link) return
            event.preventDefault()
            event.stopPropagation()
            const href = link.getAttribute("href") ?? ""
            if (/^https?:\/\//i.test(href)) openLink(href)
          }}
        >
          <MarkdownPreview
            className="whats-new-notes"
            markdown={view.body}
            placeholder="This version has no release notes."
          />
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/40 px-6 py-4">
          <Button
            variant="ghost"
            onClick={() => openLink(releasePageUrl(notes.version))}
          >
            View on GitHub
            <ArrowUpRightIcon />
          </Button>
          <DialogClose asChild>
            <Button>Got it</Button>
          </DialogClose>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function releaseDateLabel(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return `Released ${date.toLocaleDateString(undefined, { dateStyle: "long" })}`
}
