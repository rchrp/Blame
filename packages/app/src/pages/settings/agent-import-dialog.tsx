import * as React from "react"
import { DownloadIcon, LoaderCircleIcon } from "lucide-react"

import { hasImportable } from "@/components/agent-import/agent-import-model"
import { AgentImportPanel } from "@/components/agent-import/agent-import-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { usePlatform, type AgentImportScan } from "@/context/platform"

// Settings → MCP: the first-run import, whenever the person wants it again.
// A re-run only offers what Blame does not have yet.
export function AgentImportButton({ onImported }: { onImported(): void }) {
  const client = usePlatform().agentImport
  const [open, setOpen] = React.useState(false)
  const [scan, setScan] = React.useState<AgentImportScan>()
  const [scanning, setScanning] = React.useState(false)
  const [error, setError] = React.useState<string>()
  if (!client) return null

  async function start() {
    if (!client) return
    setOpen(true)
    setScan(undefined)
    setError(undefined)
    setScanning(true)
    try {
      setScan(await client.scan())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Scan failed.")
    } finally {
      setScanning(false)
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => void start()}>
        <DownloadIcon />
        Import from other tools
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import from other tools</DialogTitle>
            <DialogDescription>
              MCP servers and skills from the agent tools on this computer.
              Nothing is imported until you tick it.
            </DialogDescription>
          </DialogHeader>
          {scanning ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Looking at your other tools
            </p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : scan && client && hasImportable(scan) ? (
            <AgentImportPanel
              client={client}
              scan={scan}
              finishLabel="Done"
              onSkip={() => setOpen(false)}
              skipLabel="Cancel"
              onFinished={() => {
                setOpen(false)
                onImported()
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing new to import: what Blame can read from your other tools
              is already here.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
