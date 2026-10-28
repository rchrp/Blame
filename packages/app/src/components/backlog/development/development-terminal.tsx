import { createTerminalView } from "./terminal-view"
import { ServerOffIcon, SquareIcon, TerminalIcon } from "lucide-react"
import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import { Button } from "@/components/ui/button"
import { usePlatform } from "@/context/platform"

export function DevelopmentTerminal({ userStory }: { userStory?: UserStory }) {
  const platform = usePlatform()
  const terminalElement = React.useRef<HTMLDivElement>(null)
  const terminalSession = React.useRef<string | undefined>(undefined)
  const [sessionId, setSessionId] = React.useState<string>()

  React.useEffect(() => {
    const element = terminalElement.current
    const terminalApi = platform.terminal
    const worktree = userStory?.worktree
    if (!element || !terminalApi || !worktree) return

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let sessionId: string | undefined
    const view = createTerminalView(
      element,
      (cols, rows) => {
        if (sessionId) void terminalApi.resize({ cols, id: sessionId, rows })
      },
      (data) => {
        const id = terminalSession.current
        if (id) void terminalApi.write({ data, id })
      }
    )
    const { terminal, resize } = view

    terminal.write("\x1b[90mStarting terminal…\x1b[0m\r\n")
    terminalApi
      .start({ cwd: worktree })
      .then((session) => {
        if (cancelled) {
          void terminalApi.stop(session.id)
          return
        }
        sessionId = session.id
        terminalSession.current = session.id
        setSessionId(session.id)
        resize()
        unsubscribe = terminalApi.onEvent(session.id, (event) => {
          if (event.type === "exit") {
            terminal.write(
              `\r\n\x1b[90m[process exited ${event.data}]\x1b[0m\r\n`
            )
            terminalSession.current = undefined
            setSessionId(undefined)
            return
          }
          terminal.write(event.data)
        })
      })
      .catch(() => {
        if (cancelled) return
        terminal.write("\r\n\x1b[31mUnable to start terminal.\x1b[0m\r\n")
      })

    return () => {
      cancelled = true

      unsubscribe?.()
      if (sessionId) void terminalApi.stop(sessionId)
      terminalSession.current = undefined
      view.dispose()
    }
  }, [platform.terminal, userStory?.worktree])

  if (!userStory?.worktree) {
    return (
      <TerminalEmptyState
        description="This user story does not have a worktree yet."
        icon={TerminalIcon}
        title="No worktree"
      />
    )
  }

  if (!platform.terminal) {
    return (
      <TerminalEmptyState
        description="The desktop terminal bridge is unavailable."
        icon={ServerOffIcon}
        title="Terminal unavailable"
      />
    )
  }

  return (
    <div className="relative h-full min-h-96 bg-background">
      <div
        aria-label="Development terminal"
        className="min-h-0 overflow-hidden bg-zinc-950 p-3"
        ref={terminalElement}
        role="application"
      />
      {sessionId ? (
        <Button
          aria-label="Stop terminal"
          className="absolute top-3 right-3 size-7 bg-zinc-800/80 text-zinc-100 hover:bg-zinc-700"
          size="icon"
          title="Stop terminal"
          type="button"
          variant="secondary"
          onClick={() => void platform.terminal?.stop(sessionId)}
        >
          <SquareIcon />
        </Button>
      ) : null}
    </div>
  )
}

function TerminalEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string
  icon: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-center">
      <Icon className="size-8 text-muted-foreground" />
      <div>
        <h3 className="font-heading text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
