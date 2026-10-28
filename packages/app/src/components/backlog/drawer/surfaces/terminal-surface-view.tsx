import * as React from "react"
import { CopyIcon, RotateCwIcon } from "lucide-react"
import { createTerminalView } from "../../development/terminal-view"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"
import type {
  PreviewSurfaceScope,
  PreviewTerminalState,
} from "@/context/platform-preview-surfaces"
import { SurfaceUnavailable } from "./surface-unavailable"

export function TerminalSurfaceView({
  scope,
  active = true,
}: {
  scope: PreviewSurfaceScope
  active?: boolean
}) {
  const client = usePlatform().previewTerminal
  const element = React.useRef<HTMLDivElement>(null)
  const session = React.useRef<string | undefined>(undefined)
  const [state, setState] = React.useState<PreviewTerminalState>({
    status: "starting",
    message: "Connecting to the program",
  })
  const [attempt, retry] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => {
    if (!client || !element.current || !active) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const view = createTerminalView(
      element.current,
      (cols, rows) => {
        if (session.current)
          void client.resize({
            id: session.current,
            cols: Math.min(300, cols),
            rows: Math.min(100, rows),
          })
      },
      (data) => {
        if (session.current) void client.write({ id: session.current, data })
      }
    )
    void client
      .attach(scope)
      .then((result) => {
        if (cancelled) {
          void client.detach(result.id)
          return
        }
        session.current = result.id
        setState(result)
        view.terminal.write(result.replay)
        unsubscribe = client.onEvent(result.id, (event) => {
          if (event.type === "stdout") view.terminal.write(event.data)
          else {
            try {
              setState(JSON.parse(event.data))
            } catch {
              /* Ignore malformed state. */
            }
          }
        })
        view.resize()
      })
      .catch((error: Error) => {
        if (!cancelled)
          setState({ status: "unavailable", message: error.message })
      })
    return () => {
      cancelled = true
      unsubscribe?.()
      if (session.current) void client.detach(session.current)
      session.current = undefined
      view.dispose()
    }
  }, [
    client,
    scope.storyId,
    scope.serviceId,
    scope.worktree,
    scope.sessionId,
    active,
    attempt,
  ])
  return (
    <div className="flex h-full min-h-64 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="mr-auto text-sm text-muted-foreground" role="status">
          {state.message}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!session.current}
          onClick={() => {
            if (session.current)
              void client
                ?.restart(session.current)
                .catch((error: Error) =>
                  setState({ status: "failed", message: error.message })
                )
          }}
        >
          <RotateCwIcon />
          {state.exitCode === undefined ? "Restart" : "Run again"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!session.current}
          onClick={() => {
            if (session.current)
              void client
                ?.read(session.current)
                .then((screen) =>
                  navigator.clipboard.writeText(screen.text ?? "")
                )
          }}
        >
          <CopyIcon />
          Copy all
        </Button>
      </div>
      {state.status === "unavailable" && (
        <SurfaceUnavailable
          message={state.message}
          action="Try again"
          onAction={retry}
        />
      )}
      <div
        ref={element}
        role="application"
        aria-label="Program terminal"
        className="min-h-0 flex-1 overflow-hidden bg-zinc-950 p-3"
      />
    </div>
  )
}
