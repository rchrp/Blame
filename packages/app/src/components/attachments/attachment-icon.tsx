import {
  FileIcon,
  FileTextIcon,
  FileTypeIcon,
  FileSpreadsheetIcon,
  FileCodeIcon,
  Music2Icon,
  VideoIcon,
  PresentationIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { AttachmentFormat } from "./attachment-format"

const icons = {
  pdf: [FileTypeIcon, "text-red-500"],
  word: [FileTextIcon, "text-blue-500"],
  spreadsheet: [FileSpreadsheetIcon, "text-emerald-500"],
  csv: [FileSpreadsheetIcon, "text-emerald-500"],
  markdown: [FileTextIcon, "text-sky-500"],
  latex: [FileCodeIcon, "text-teal-500"],
  text: [FileCodeIcon, "text-slate-500 dark:text-slate-400"],
  audio: [Music2Icon, "text-violet-500"],
  video: [VideoIcon, "text-pink-500"],
  slides: [PresentationIcon, "text-orange-500"],
  file: [FileIcon, "text-muted-foreground"],
} as const

export function AttachmentIcon({
  format,
  className,
}: {
  format: AttachmentFormat
  className?: string
}) {
  const [Icon, color] = icons[format]
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", color, className)}
    />
  )
}
