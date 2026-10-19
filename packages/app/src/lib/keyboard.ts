import * as React from "react"

// Small keyboard helpers shared by onboarding screens and app-wide shortcuts.

export const isMac =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform
  )

// "⌘" on macOS, "Ctrl" elsewhere.
export const modKeyLabel = isMac ? "⌘" : "Ctrl"

export function hasModKey(event: KeyboardEvent | React.KeyboardEvent) {
  return isMac ? event.metaKey : event.ctrlKey
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']")
  )
}

// True when the event happens inside something that owns its keys: a text
// field, a listbox (command menus), or an open dialog/popover.
export function isKeyOwnedByTarget(target: EventTarget | null) {
  if (isEditableTarget(target)) return true
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      "[role='listbox'], [role='menu'], [role='dialog'], [role='alertdialog'], [cmdk-root]"
    )
  )
}

function dialogOpen() {
  return Boolean(
    document.querySelector(
      "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"
    )
  )
}

export type WizardKeys = {
  // Enter, when no field, list or button owns it: next step.
  onNext?: () => void
  // Escape or Alt+Left: previous step / skip.
  onBack?: () => void
  enabled?: boolean
}

// Enter moves forward and Escape moves back, the same on every step of a
// flow. Fields, lists and dialogs keep their own keys.
export function useWizardKeys({ onNext, onBack, enabled = true }: WizardKeys) {
  const handlers = React.useRef({ onNext, onBack })

  React.useEffect(() => {
    handlers.current = { onNext, onBack }
  })

  React.useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (dialogOpen()) return
      const { onNext: next, onBack: back } = handlers.current

      if (event.key === "Enter" && next) {
        // Fields, lists and buttons handle Enter themselves; anywhere else
        // it moves to the next step.
        const target = event.target
        const onButton =
          target instanceof HTMLElement && target.closest("button, a[href]")
        if (isKeyOwnedByTarget(target) || onButton) return
        event.preventDefault()
        next()
        return
      }

      const backKey =
        (event.key === "Escape" && !isEditableTarget(event.target)) ||
        (event.key === "ArrowLeft" && event.altKey)
      if (backKey && back) {
        event.preventDefault()
        back()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [enabled])
}

// Arrow-key focus movement through a grid or list of buttons, so a row of
// choices behaves like one control. Attach the returned handler to the
// container's onKeyDown.
export function useRovingFocus(columns = 1) {
  return React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]
      if (!keys.includes(event.key) || event.altKey) return
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "[data-roving-item]:not([disabled])"
        )
      )
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (index === -1) return
      const step =
        event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowLeft"
            ? -1
            : event.key === "ArrowDown"
              ? columns
              : event.key === "ArrowUp"
                ? -columns
                : 0
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : Math.min(Math.max(index + step, 0), items.length - 1)
      event.preventDefault()
      items[next]?.focus()
    },
    [columns]
  )
}
