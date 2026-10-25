import DOMPurify from "dompurify"
import {
  attachmentExtension,
  hasDocumentPreview,
  previewLimits,
} from "./attachment-format"
import { readAttachmentFile } from "./attachment-file"
import type { ComposerAttachment, DocumentPreview } from "./attachment-types"

// Weak keys release previews with their composer. Only two parsers run at once;
// each Office parser lives in a disposable worker with a hard time limit.
const cache = new WeakMap<File, Promise<DocumentPreview>>()
const waiting: (() => void)[] = []
let active = 0

export function documentPreview(attachment: ComposerAttachment, retry = false) {
  if (retry) cache.delete(attachment.file)
  const current = cache.get(attachment.file)
  if (current) return current
  const pending = queued(() => createPreview(attachment))
  cache.set(attachment.file, pending)
  return pending
}

async function queued<T>(operation: () => Promise<T>) {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
  else active++
  try {
    return await operation()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

async function createPreview(
  attachment: ComposerAttachment
): Promise<DocumentPreview> {
  const ext = attachmentExtension(attachment.file.name)
  if (!hasDocumentPreview(attachment.file)) {
    const text =
      attachment.aiContextMarkdown ??
      attachment.storedAttachment?.aiContextMarkdown
    if (text)
      return {
        kind: "markdown",
        text: text.slice(0, previewLimits.text),
        truncated: text.length > previewLimits.text,
      }
    throw new Error(
      "No preview is available for this format. Open or download the original."
    )
  }
  const file = await readAttachmentFile(
    attachment,
    ["docx", "xlsx"].includes(ext)
      ? previewLimits.officeBytes
      : previewLimits.bytes
  )
  if (file.type === "application/pdf" || ext === "pdf") {
    const { pdfThumbnail } = await import("./pdf-preview")
    return { kind: "pdf", thumbnail: await pdfThumbnail(file) }
  }
  const result = await parseDocument(file)
  if (result.kind === "html") result.html = sanitizeDocumentHtml(result.html)
  return result
}

function parseDocument(file: File) {
  return new Promise<DocumentPreview>((resolve, reject) => {
    const worker = new Worker(
      new URL("./document-parser.worker.ts", import.meta.url),
      { type: "module" }
    )
    const finish = () => {
      clearTimeout(timeout)
      worker.terminate()
    }
    const timeout = setTimeout(() => {
      finish()
      reject(
        new Error(
          "This document is taking too long to preview. Open or download the original."
        )
      )
    }, 15_000)
    worker.onmessage = ({
      data,
    }: MessageEvent<{ result?: DocumentPreview; error?: string }>) => {
      finish()
      if (data.result) resolve(data.result)
      else reject(new Error(data.error || "Preview unavailable"))
    }
    worker.onerror = () => {
      finish()
      reject(
        new Error(
          "Unable to preview this document. Open or download the original."
        )
      )
    }
    worker.postMessage(file)
  })
}

export function sanitizeDocumentHtml(html: string) {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "u",
      "s",
      "br",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "pre",
      "code",
      "img",
      "sup",
      "sub",
      "hr",
    ],
    ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan"],
    RETURN_DOM_FRAGMENT: true,
  })
  for (const img of fragment.querySelectorAll("img")) {
    if (
      !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(
        img.getAttribute("src") ?? ""
      )
    )
      img.remove()
  }
  const container = document.createElement("div")
  container.append(fragment)
  return container.innerHTML
}
