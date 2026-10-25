import { GlobalWorkerOptions, getDocument } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

GlobalWorkerOptions.workerSrc = workerUrl

export async function loadPdf(file: File) {
  // PDF JavaScript, actions, links, and embedded files are never executed.
  return getDocument({
    data: await file.arrayBuffer(),
    useSystemFonts: true,
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
  })
}

export async function pdfThumbnail(file: File) {
  const task = await loadPdf(file)
  const timeout = setTimeout(() => void task.destroy(), 15_000)
  try {
    const pdf = await task.promise
    const page = await pdf.getPage(1)
    const natural = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({
      scale: Math.min(480 / natural.width, 640 / natural.height),
    })
    const canvas = document.createElement("canvas")
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    return canvas.toDataURL("image/png")
  } finally {
    clearTimeout(timeout)
    await task.destroy()
  }
}
