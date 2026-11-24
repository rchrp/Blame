import { createTerminalView, type TerminalView } from "./terminal-view"
import { ServerOffIcon, SquareIcon, TerminalIcon } from "lucide-react"
import * as React from "react"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  CodeActionsSpace,
  DevelopmentEmptyState,
} from "@/components/backlog/development/development-code-panel"
import { AttachedTabs } from "@/components/backlog/shared/attached-tabs"
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
    let view: TerminalView | undefined
    const startTerminal = ({ terminal, resize }: TerminalView) => {
      terminal.write("\x1b[90mStarting terminal…\x1b[0m\r\n")
      return terminalApi
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
    }

    void createTerminalView(
      element,
      (cols, rows) => {
        if (sessionId) void terminalApi.resize({ cols, id: sessionId, rows })
      },
      (data) => {
        const id = terminalSession.current
        if (id) void terminalApi.write({ data, id })
      }
    )
      .then((created) => {
        if (cancelled) {
          created.dispose()
          return
        }
        view = created
        return startTerminal(created)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true

      unsubscribe?.()
      if (sessionId) void terminalApi.stop(sessionId)
      terminalSession.current = undefined
      view?.dispose()
    }
  }, [platform.terminal, userStory?.worktree])

  if (!userStory?.worktree) {
    return (
      <DevelopmentEmptyState
        description="This user story does not have a worktree yet."
        icon={TerminalIcon}
        title="No worktree"
      />
    )
  }

  if (!platform.terminal) {
    return (
      <DevelopmentEmptyState
        description="The desktop terminal bridge is unavailable."
        icon={ServerOffIcon}
        title="Terminal unavailable"
      />
    )
  }

  // As a preview's run logs: its tab set on a dark terminal.
  return (
    <div className="flex h-full min-h-0 flex-col py-4">
      <div className="flex h-(--attached-tab-height) shrink-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <AttachedTabs
            items={[
              {
                id: "terminal",
                label: "Terminal",
                status: sessionId ? "running" : "stopped",
              },
            ]}
            label="Terminals"
            value="terminal"
            onValueChange={() => undefined}
          />
        </div>
        <CodeActionsSpace />
      </div>
      <div className="relative -mt-px min-h-0 flex-1 overflow-hidden rounded-xl rounded-tl-none border bg-terminal-surface">
        <div
          aria-label="Development terminal"
          className="h-full min-h-0 overflow-hidden p-3"
          ref={terminalElement}
          role="application"
        />
        {sessionId ? (
          <Button
            aria-label="Stop terminal"
            className="absolute top-3 right-3 size-7 bg-white/10 text-neutral-100 hover:bg-white/20"
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
    </div>
  )
}
