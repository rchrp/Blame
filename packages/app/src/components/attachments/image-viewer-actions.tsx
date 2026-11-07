import * as React from "react"
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

// Copy and save buttons of the image viewer. Failures go to `onError`.
export function ImageViewerActions({
  disabled,
  onCopy,
  onError,
  onSave,
}: {
  disabled: boolean
  onCopy: () => Promise<boolean>
  onError: (message: string) => void
  onSave: () => Promise<unknown>
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  async function run(action: () => Promise<unknown>) {
    try {
      return await action()
    } catch (reason) {
      onError(
        reason instanceof Error ? reason.message : "The image action failed."
      )
      return false
    }
  }
  return (
    <span className="flex items-center gap-1.5">
      <Button
        type="button"
        disabled={disabled}
        onClick={() => void run(onCopy).then((done) => setCopied(done === true))}
        size="sm"
        variant="outline"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy image"}
      </Button>
      <Button
        type="button"
        disabled={disabled}
        onClick={() => void run(onSave)}
        size="sm"
        variant="outline"
      >
        <DownloadIcon />
        Save as…
      </Button>
    </span>
  )
}
