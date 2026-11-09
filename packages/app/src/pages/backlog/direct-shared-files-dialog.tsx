import type { DirectStoryFile } from "@blame/agent-runtime"
import { TriangleAlertIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { SharedFilesChoice } from "./direct-story-commit"

export type DirectSharedFilesDialogProps = {
  files: DirectStoryFile[]
  onChoose(choice: SharedFilesChoice): void
  open: boolean
}

// Approve & Commit found files the story wrote that also hold other changes:
// the person decides whether they go into the story's commit.
export function DirectSharedFilesDialog({
  files,
  onChoose,
  open,
}: DirectSharedFilesDialogProps) {
  const shared = files.filter((file) => file.shared)
  const hasOwnFiles = shared.length < files.length
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onChoose("cancel")
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <TriangleAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {shared.length === 1
              ? "1 file also holds other changes"
              : `${shared.length} files also hold other changes`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {shared.length === 1 ? "This file was" : "These files were"} already
            modified before the story, or changed by someone else since.
            Committing {shared.length === 1 ? "it" : "them"} puts those changes in
            the story's commit.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {shared.map((file) => (
            <li key={file.path} className="break-all">
              {file.path}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {hasOwnFiles && (
            <AlertDialogAction
              variant="outline"
              onClick={() => onChoose("leave-out")}
            >
              Leave {shared.length === 1 ? "it" : "them"} out
            </AlertDialogAction>
          )}
          <AlertDialogAction onClick={() => onChoose("commit")}>
            Commit {shared.length === 1 ? "it" : "them"} too
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
