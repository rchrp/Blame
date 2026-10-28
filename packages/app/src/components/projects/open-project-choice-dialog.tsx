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

export type OpenProjectChoice = "cancel" | "new-window" | "this-window"

// Asked when a project opens while another one is open: keep both side by
// side in two windows, or switch this window over.
export function OpenProjectChoiceDialog({
  onChoose,
  projectName,
}: {
  onChoose(choice: OpenProjectChoice, remember: boolean): void
  // The dialog is open while a name is given.
  projectName?: string
}) {
  const [remember, setRemember] = React.useState(false)
  const choose = (choice: OpenProjectChoice) => {
    onChoose(choice, remember && choice !== "cancel")
    setRemember(false)
  }
  return (
    <AlertDialog
      open={projectName !== undefined}
      onOpenChange={(open) => {
        if (!open) choose("cancel")
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Open Project</AlertDialogTitle>
          <AlertDialogDescription>
            Where would you like to open “{projectName}”?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Label className="flex w-fit items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          Don't ask again
        </Label>
        <AlertDialogFooter>
          <AlertDialogCancel className="sm:mr-auto">Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            className="border-primary dark:border-primary"
            onClick={() => choose("new-window")}
          >
            New Window
          </Button>
          <Button autoFocus onClick={() => choose("this-window")}>
            This Window
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
