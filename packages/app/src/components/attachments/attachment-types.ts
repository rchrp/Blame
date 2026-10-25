import type { UserStoryFileAttachment } from "@/components/backlog/data/backlog-data"
import type { ImageAnnotation } from "./image-attachment-gallery"

export type ComposerAttachment = {
  annotation?: ImageAnnotation
  id: string
  file: File
  previewUrl?: string
  source: "code" | "file"
  storedAttachment?: UserStoryFileAttachment
  subtitle?: string
  title?: string
}

export type DocumentPreview =
  | { kind: "pdf"; thumbnail: string }
  | { kind: "html"; html: string; thumbnailHtml?: string; truncated: boolean }
  | { kind: "markdown" | "text"; text: string; truncated: boolean }
  | { kind: "spreadsheet"; sheets: PreviewSheet[]; truncated: boolean }

export type PreviewSheet = { name: string; rows: string[][] }
