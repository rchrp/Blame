import * as React from "react"
import { DatabaseIcon, ServerIcon } from "lucide-react"
import type { ProjectInitializationDatabaseMode } from "@blame/agent-runtime"

import {
  DatabaseModeOptions,
  databaseModeOptions,
} from "@/components/project-initialization/database-mode-options"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// The database every preview of the project uses, with a way to change it.
// A change runs the analysis again with the new choice: an isolated database
// needs a database service in the setup, the project's own needs none.

export function DatabaseModeReminder({
  mode,
  disabled,
  onChange,
}: {
  mode: ProjectInitializationDatabaseMode
  disabled?: boolean
  onChange(mode: ProjectInitializationDatabaseMode): void
}) {
  const [open, setOpen] = React.useState(false)
  const option = databaseModeOptions.find((entry) => entry.mode === mode)!
  const Icon = mode === "compose" ? DatabaseIcon : ServerIcon
  return (
    <section className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm">
          <span className="text-muted-foreground">Database · </span>
          <span className="font-medium">{option.title}</span>
        </p>
        <p className="text-xs text-muted-foreground">{option.detail}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Change
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Database for this project&apos;s previews</DialogTitle>
            <DialogDescription>
              Blame analyzes the project again with your choice, then stories
              started from now on use it.
            </DialogDescription>
          </DialogHeader>
          <DatabaseModeOptions
            current={mode}
            onSelect={(next) => {
              setOpen(false)
              if (next !== mode) onChange(next)
            }}
          />
        </DialogContent>
      </Dialog>
    </section>
  )
}
