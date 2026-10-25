import { useState } from "react"
import { toast } from "sonner"
import { usePlatform } from "@/context/platform"
import { downloadAttachment, readAttachmentFile } from "./attachment-file"
import type { ComposerAttachment } from "./attachment-types"
import { attachmentExtension } from "./attachment-format"

const nativeExtensions = new Set(
  "pdf doc docx xls xlsx csv tsv ppt pptx odt ods odp rtf txt md markdown tex latex mp3 wav m4a aac ogg flac aiff opus mp4 mov webm mkv".split(
    " "
  )
)

export function useAttachmentActions(attachment: ComposerAttachment) {
  const platform = usePlatform()
  const [busy, setBusy] = useState(false)
  const canOpen =
    Boolean(platform.openAttachment) &&
    nativeExtensions.has(attachmentExtension(attachment.file.name))
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to open this file",
        {
          action: {
            label: "Download",
            onClick: () => void downloadAttachment(attachment),
          },
        }
      )
    } finally {
      setBusy(false)
    }
  }
  return {
    busy,
    canOpen,
    download: () => run(() => downloadAttachment(attachment)),
    open: () =>
      run(async () => {
        if (!canOpen || !platform.openAttachment)
          return downloadAttachment(attachment)
        const file = await readAttachmentFile(attachment)
        await platform.openAttachment({
          name: file.name,
          content: new Uint8Array(await file.arrayBuffer()),
        })
      }),
  }
}
