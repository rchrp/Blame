import {
  attachmentExtension,
  attachmentFormat,
  previewLimits,
} from "./attachment-format"
import type { DocumentPreview } from "./attachment-types"

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    self.postMessage({ result: await parse(data) })
  } catch {
    self.postMessage({
      error:
        "This file could not be previewed. Try opening or downloading the original.",
    })
  }
}

async function parse(file: File): Promise<DocumentPreview> {
  const format = attachmentFormat(file)
  if (attachmentExtension(file.name) === "docx") {
    const { default: mammoth } = await import("mammoth")
    const { value } = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          if (!/^image\/(png|jpeg|gif|webp)$/.test(image.contentType))
            return { src: "" }
          const bytes = await image.readAsArrayBuffer()
          if (bytes.byteLength > 2 * 1024 * 1024) return { src: "" }
          return {
            src: `data:${image.contentType};base64,${await image.readAsBase64String()}`,
          }
        }),
      }
    )
    if (value.length > 4_000_000) throw new Error("Document too large")
    return { kind: "html", html: value, truncated: false }
  }
  if (attachmentExtension(file.name) === "xlsx") {
    const { default: readExcel } = await import("read-excel-file/web-worker")
    const sheets = await readExcel(await file.arrayBuffer())
    return {
      kind: "spreadsheet",
      truncated:
        sheets.length > previewLimits.sheets ||
        sheets.some(
          ({ data }) =>
            data.length > previewLimits.rows ||
            data.some((row) => row.length > previewLimits.columns)
        ),
      sheets: sheets.slice(0, previewLimits.sheets).map(({ sheet, data }) => ({
        name: sheet,
        rows: data
          .slice(0, previewLimits.rows)
          .map((row) =>
            row
              .slice(0, previewLimits.columns)
              .map((cell) =>
                cell instanceof Date
                  ? cell.toISOString().slice(0, 10)
                  : String(cell ?? "").slice(0, 2000)
              )
          ),
      })),
    }
  }
  if (format === "csv") {
    const { default: Papa } = await import("papaparse")
    const { data, meta } = Papa.parse<string[]>(await file.text(), {
      preview: previewLimits.rows,
      skipEmptyLines: true,
      delimiter: attachmentExtension(file.name) === "tsv" ? "\t" : "",
    })
    return {
      kind: "spreadsheet",
      truncated:
        Boolean(meta.truncated) ||
        data.some((row) => row.length > previewLimits.columns),
      sheets: [
        {
          name: "Sheet 1",
          rows: data.map((row) =>
            row
              .slice(0, previewLimits.columns)
              .map((cell) => cell.slice(0, 2000))
          ),
        },
      ],
    }
  }
  const text = await file.slice(0, previewLimits.text * 4).text()
  if (text.includes("\0")) throw new Error("Binary content")
  return {
    kind: format === "markdown" ? "markdown" : "text",
    text: text.slice(0, previewLimits.text),
    truncated:
      text.length > previewLimits.text || file.size > previewLimits.text * 4,
  }
}
