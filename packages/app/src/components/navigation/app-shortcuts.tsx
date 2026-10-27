import * as React from "react"

import { navigate } from "@/components/navigation/navigation"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { hasModKey, isEditableTarget, modKeyLabel } from "@/lib/keyboard"

// App-wide keyboard shortcuts. One small table so the shortcuts, the sidebar
// hints and the help dialog never drift apart.

export const routeShortcuts = [
  { key: "1", path: "/backlog", label: "Backlog" },
  { key: "2", path: "/chat", label: "Chat" },
  { key: "3", path: "/git", label: "Git" },
  { key: "4", path: "/initialization", label: "Initialization" },
  { key: "5", path: "/practices", label: "Code Practices" },
  { key: "6", path: "/security", label: "Security Audit" },
  { key: "7", path: "/deploy", label: "Deploy" },
] as const

export function routeShortcutLabel(path: string) {
  const shortcut = routeShortcuts.find((item) => item.path === path)
  return shortcut ? `${modKeyLabel}${shortcut.key}` : undefined
}

const shortcutGroups: {
  title: string
  items: { keys: string[]; label: string }[]
}[] = [
  {
    title: "Navigate",
    items: [
      ...routeShortcuts.map((item) => ({
        keys: [modKeyLabel, item.key],
        label: item.label,
      })),
      { keys: [modKeyLabel, ","], label: "Settings" },
      { keys: [modKeyLabel, "B"], label: "Toggle sidebar" },
    ],
  },
  {
    title: "Write",
    items: [
      { keys: ["/"], label: "Focus the chat composer" },
      { keys: ["↵"], label: "Send message" },
      { keys: ["Shift", "↵"], label: "New line" },
      { keys: [modKeyLabel, "↵"], label: "Send story to the dev agent" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: [modKeyLabel, "K"], label: "Command palette" },
      { keys: [modKeyLabel, "/"], label: "Show keyboard shortcuts" },
      { keys: ["D"], label: "Toggle light and dark theme" },
      { keys: ["Esc"], label: "Close dialog or panel" },
    ],
  },
]

export function useAppShortcuts() {
  const [helpOpen, setHelpOpen] = React.useState(false)

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return

      if (hasModKey(event) && !event.altKey && !event.shiftKey) {
        const route = routeShortcuts.find((item) => item.key === event.key)
        if (route) {
          event.preventDefault()
          navigate(route.path)
          return
        }
        if (event.key === ",") {
          event.preventDefault()
          navigate("/settings")
          return
        }
        if (event.key === "/") {
          event.preventDefault()
          setHelpOpen((open) => !open)
          return
        }
      }

      if (
        event.key === "?" &&
        !hasModKey(event) &&
        !event.altKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault()
        setHelpOpen(true)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  return { helpOpen, setHelpOpen }
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Move around Blame without leaving the keyboard.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {shortcutGroups.map((group) => (
            <section
              key={group.title}
              className={group.title === "Navigate" ? "sm:row-span-2" : undefined}
            >
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.title}
              </h3>
              <ul className="grid gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.label}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>{item.label}</span>
                    <KbdGroup>
                      {item.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
