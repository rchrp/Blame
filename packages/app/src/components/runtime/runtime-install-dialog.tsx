import * as React from "react"
import { BoxIcon, ExternalLinkIcon, RefreshCwIcon, WrenchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useBlameRuntime } from "@/context/blame-runtime"
import { usePlatform } from "@/context/platform"
import { saveStoryRunMode } from "@/lib/runtime-preference"
import { runtimeFailureTitle } from "@/pages/backlog/runtime-failure"

// The one dialog about the Blame Runtime. It opens when someone picks Local
// Container without it, or asks for details after a failed repair. Installing
// never blocks: the dialog closes and progress shows bottom right.
export function RuntimeInstallDialog() {
  const runtime = useBlameRuntime()
  const platform = usePlatform()
  const open = Boolean(runtime.prompt)
  const repair = runtime.phase === "needs-repair"
  const unsupported = runtime.phase === "unsupported"
  const linux = !runtime.canInstall && platform.platform === "linux"
  const storyTitle = runtime.prompt?.storyTitle

  // Nothing to say any more once it works.
  React.useEffect(() => {
    if (open && runtime.phase === "ready") runtime.closePrompt()
  }, [open, runtime])

  function start(action: () => Promise<boolean>) {
    runtime.prompt?.onAccept?.()
    runtime.closePrompt()
    void action()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && runtime.closePrompt()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/30 dark:text-blue-300">
            {repair ? <WrenchIcon className="size-5" /> : <BoxIcon className="size-5" />}
          </div>
          <DialogTitle>
            {unsupported
              ? "Local containers aren't available on this computer"
              : repair
                ? "Blame Runtime needs a repair"
                : "Install Blame Runtime"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {unsupported
              ? "Blame Runtime needs WSL 2 on Windows or macOS 13 or later. You can still run stories in the cloud or directly in your project."
              : repair
                ? "The automatic repair didn't work. Repairing reinstalls the parts that are broken; your projects are not touched."
                : "Local Container runs each story and its preview in an isolated sandbox on this computer. It installs once in the background, takes a few minutes, and keeps itself up to date."}
          </DialogDescription>
        </DialogHeader>
        {storyTitle ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Waiting for it: </span>
            {storyTitle}
          </p>
        ) : null}
        {repair && runtime.lastError ? (
          <pre className="max-h-32 overflow-auto rounded-lg bg-muted/50 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
            {runtime.lastError}
          </pre>
        ) : null}
        {linux ? (
          <p className="text-sm text-muted-foreground">
            On Linux, Blame uses Docker Engine and Docker Compose from your
            system. Install them, then check again.
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {repair && runtime.canInstall ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => start(runtime.reset)}
            >
              Start over
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {repair && runtime.lastError && platform.reportIssue ? (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void platform.reportIssue?.({
                    error: runtime.lastError ?? "",
                    title: runtimeFailureTitle("repair"),
                  })
                }
              >
                Report on GitHub
              </Button>
            ) : storyTitle ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  saveStoryRunMode("direct")
                  runtime.closePrompt()
                }}
              >
                Use Direct instead
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={runtime.closePrompt}>
                Not now
              </Button>
            )}
            {linux ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    platform.openExternalLink?.("https://docs.docker.com/engine/install/")
                  }
                >
                  <ExternalLinkIcon /> Docker
                </Button>
                <Button type="button" onClick={() => void runtime.refresh()}>
                  <RefreshCwIcon /> Check again
                </Button>
              </>
            ) : runtime.canInstall && !unsupported ? (
              <Button type="button" autoFocus onClick={() => start(runtime.install)}>
                {repair ? "Repair" : "Install in the background"}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
