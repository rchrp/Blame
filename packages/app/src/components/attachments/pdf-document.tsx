import { useEffect, useRef, useState, type ReactNode } from "react"
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  LoaderCircleIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { readAttachmentFile } from "./attachment-file"
import { previewLimits } from "./attachment-format"
import type { ComposerAttachment } from "./attachment-types"
import { loadPdf } from "./pdf-preview"

export default function PdfDocument({
  attachment,
  actions,
}: {
  attachment: ComposerAttachment
  actions: ReactNode
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [error, setError] = useState("")
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    const controller = new AbortController()
    let task: Awaited<ReturnType<typeof loadPdf>> | undefined
    const timeout = setTimeout(() => {
      controller.abort()
      void task?.destroy()
      setError("This PDF took too long to load. Download or open the original.")
    }, 30_000)
    void readAttachmentFile(attachment, previewLimits.bytes, controller.signal)
      .then(async (file) => {
        task = await loadPdf(file)
        if (controller.signal.aborted) {
          await task.destroy()
          return
        }
        const document = await task.promise
        if (!controller.signal.aborted) setPdf(document)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Unable to read this PDF. It may be protected or damaged. Open or download the original."
          )
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      controller.abort()
      clearTimeout(timeout)
      void task?.destroy()
    }
  }, [attachment])
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        onKeyDown={(event) => {
          if (event.key === "PageDown" && pdf) {
            event.preventDefault()
            setPage((value) => Math.min(pdf.numPages, value + 1))
          }
          if (event.key === "PageUp") {
            event.preventDefault()
            setPage((value) => Math.max(1, value - 1))
          }
        }}
        tabIndex={0}
        aria-label="PDF document. Use Page Up and Page Down to change pages."
      >
        {error ? (
          <p
            role="alert"
            className="mx-auto max-w-md rounded-xl bg-background/90 p-6 text-center text-sm"
          >
            {error}
          </p>
        ) : pdf ? (
          <PdfCanvas pdf={pdf} pageNumber={page} zoom={zoom} />
        ) : (
          <div
            role="status"
            className="flex h-full items-center justify-center"
          >
            <LoaderCircleIcon className="size-6 animate-spin" />
            <span className="sr-only">Loading PDF</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
        {pdf && (
          <div className="flex items-center gap-1 rounded-xl bg-popover/85 p-1.5 shadow-lg backdrop-blur-xl">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous page"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span
              className="min-w-16 text-center text-xs tabular-nums"
              aria-live="polite"
            >
              {page} / {pdf.numPages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next page"
              disabled={page === pdf.numPages}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRightIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              disabled={zoom <= 0.5}
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
            >
              <MinusIcon />
            </Button>
            <button
              type="button"
              className="min-w-10 rounded px-1 py-2 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Fit page"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              disabled={zoom >= 2}
              onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
            >
              <PlusIcon />
            </Button>
          </div>
        )}
        {actions}
      </div>
    </>
  )
}

function PdfCanvas({
  pdf,
  pageNumber,
  zoom,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  zoom: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 700 })
  const [error, setError] = useState("")
  const [text, setText] = useState("")
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setSize({
        width: entries[0].contentRect.width,
        height: entries[0].contentRect.height,
      })
    )
    if (container.current?.parentElement)
      observer.observe(container.current.parentElement)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const host = container.current
    if (!host || size.width <= 0 || size.height <= 0) return
    let cancelled = false
    let render: RenderTask | undefined
    const canvas = document.createElement("canvas")
    void pdf
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return
        void page
          .getTextContent()
          .then((content) => {
            if (!cancelled)
              setText(
                content.items
                  .map((item) => ("str" in item ? item.str : ""))
                  .join(" ")
                  .slice(0, 50_000)
              )
          })
          .catch(() => {
            if (!cancelled) setText("")
          })
        const natural = page.getViewport({ scale: 1 })
        const cssWidth =
          Math.min(
            size.width,
            1100,
            (size.height * natural.width) / natural.height
          ) * zoom
        const density = Math.min(window.devicePixelRatio || 1, 2)
        const scale = Math.min(
          (cssWidth * density) / natural.width,
          Math.sqrt(12_000_000 / (natural.width * natural.height))
        )
        const viewport = page.getViewport({ scale })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${cssWidth}px`
        canvas.style.height = `${(cssWidth * natural.height) / natural.width}px`
        canvas.className = "mx-auto block bg-white shadow-lg"
        canvas.setAttribute("aria-label", `PDF page ${pageNumber}`)
        canvas.setAttribute("role", "img")
        render = page.render({ canvas, viewport })
        await render.promise
        if (!cancelled) {
          host.replaceChildren(canvas)
          setError("")
        }
      })
      .catch((error) => {
        if (!cancelled && error?.name !== "RenderingCancelledException")
          setError("This page could not be rendered.")
      })
    return () => {
      cancelled = true
      render?.cancel()
      canvas.remove()
    }
  }, [pdf, pageNumber, size, zoom])
  return (
    <>
      {error && (
        <p role="alert" className="p-4 text-center">
          {error}
        </p>
      )}
      <div ref={container} className="min-h-32 w-full" />
      <p className="sr-only">{text}</p>
    </>
  )
}
