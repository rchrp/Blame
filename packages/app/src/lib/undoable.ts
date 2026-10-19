import { toast } from "sonner"

// Runs a reversible action with an "Undo" toast instead of a confirmation
// dialog. The action is applied to the interface right away; the real,
// permanent part only runs once the toast goes away without an undo.
export function undoable({
  commit,
  durationMs = 5_000,
  message,
  undo,
}: {
  message: string
  // Restores the interface.
  undo: () => void
  // Makes the change permanent (server call, deletion…).
  commit: () => Promise<void> | void
  durationMs?: number
}) {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    void Promise.resolve(commit()).catch((error: unknown) => {
      undo()
      toast.error("That didn't go through", {
        description: error instanceof Error ? error.message : "Please try again.",
        position: "bottom-right",
      })
    })
  }
  toast(message, {
    duration: durationMs,
    position: "bottom-right",
    action: {
      label: "Undo",
      onClick: () => {
        if (settled) return
        settled = true
        undo()
      },
    },
    onAutoClose: finish,
    onDismiss: finish,
  })
}
