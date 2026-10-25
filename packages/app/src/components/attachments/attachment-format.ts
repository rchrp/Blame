export type AttachmentFormat =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "csv"
  | "markdown"
  | "latex"
  | "text"
  | "audio"
  | "video"
  | "slides"
  | "file"

const extensions: Record<string, AttachmentFormat> = {
  pdf: "pdf",
  docx: "word",
  doc: "word",
  xlsx: "spreadsheet",
  xls: "spreadsheet",
  csv: "csv",
  tsv: "csv",
  md: "markdown",
  markdown: "markdown",
  tex: "latex",
  latex: "latex",
  txt: "text",
  log: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  xml: "text",
  html: "text",
  css: "text",
  js: "text",
  ts: "text",
  tsx: "text",
  jsx: "text",
  py: "text",
  rs: "text",
  go: "text",
  java: "text",
  c: "text",
  cpp: "text",
  h: "text",
  sh: "text",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  flac: "audio",
  aiff: "audio",
  opus: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  ppt: "slides",
  pptx: "slides",
}

export function attachmentExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? ""
}

export function attachmentFormat(file: {
  name: string
  type: string
}): AttachmentFormat {
  const format = extensions[attachmentExtension(file.name)]
  if (format) return format
  if (file.type === "application/pdf") return "pdf"
  if (file.type === "text/markdown") return "markdown"
  if (file.type.startsWith("text/")) return "text"
  if (file.type.startsWith("audio/")) return "audio"
  if (file.type.startsWith("video/")) return "video"
  return "file"
}

export function hasDocumentPreview(
  file: { name: string; type: string },
  markdown?: string
) {
  const format = attachmentFormat(file)
  if (format === "audio" || format === "video") return false
  return (
    Boolean(markdown) ||
    ["pdf", "csv", "markdown", "latex", "text"].includes(format) ||
    ["docx", "xlsx"].includes(attachmentExtension(file.name))
  )
}

export const previewLimits = {
  bytes: 25 * 1024 * 1024,
  officeBytes: 10 * 1024 * 1024,
  text: 200_000,
  rows: 1000,
  columns: 50,
  sheets: 20,
}
