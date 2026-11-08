import * as React from "react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

export type PreviewSetupChoice = "set-up" | "not-now"

// Asked before the first analysis of a project: the setup agent reads the
// repository with the person's AI provider.
export function PreviewSetupDialog({
  onChoose,
  projectName,
}: {
  onChoose(choice: PreviewSetupChoice, remember: boolean): void
  // The dialog is open while a name is given.
  projectName?: string
}) {
  const [remember, setRemember] = React.useState(false)
  const choose = (choice: PreviewSetupChoice) => {
    onChoose(choice, remember)
    setRemember(false)
  }
  return (
    <AlertDialog
      open={projectName !== undefined}
      onOpenChange={(open) => {
        if (!open) choose("not-now")
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Set up previews for “{projectName}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            An agent will read this project with your AI provider and write down
            how it runs: its app, its services, and how to start them. Each story
            can then open its own preview. Without it, only stories in Direct
            mode can start. You can run it later from the Preview Environment
            page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Label className="flex w-fit items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          Remember my choice
        </Label>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <Button autoFocus onClick={() => choose("set-up")}>
            Set up previews
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
