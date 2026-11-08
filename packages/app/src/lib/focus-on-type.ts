import { isFieldOrMenuTarget, topDialog } from "@/lib/keyboard"
import { isTypedCharacter } from "@/lib/typed-character"

// Typing a character while nothing owns the keyboard sends it to the visible,
// editable editor of the current page or of the top dialog, as after a click.

export type FocusOnTypeEditor = {
  element: () => HTMLElement | null
  // Focuses the editor with the caret at the end of its text.
  focusAtEnd: () => void
}

const editors = new Set<FocusOnTypeEditor>()

const activatesOnSpaceSelector =
  "button, a[href], summary, [role='button'], [role='checkbox'], [role='radio'], [role='switch'], [role='tab']"

export function registerFocusOnTypeEditor(editor: FocusOnTypeEditor) {
  if (editors.size === 0)
    window.addEventListener("keydown", handleKeyDown, true)
  editors.add(editor)
  return () => {
    editors.delete(editor)
    if (editors.size === 0)
      window.removeEventListener("keydown", handleKeyDown, true)
  }
}

function isVisible(element: HTMLElement) {
  return (
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  )
}

// The first editor, in document order, that shows on the current layer.
function typingEditor() {
  const dialog = topDialog()
  const candidates: { editor: FocusOnTypeEditor; element: HTMLElement }[] = []
  for (const editor of editors) {
    const element = editor.element()
    if (!element || !isVisible(element)) continue
    if (dialog && !dialog.contains(element)) continue
    candidates.push({ editor, element })
  }
  candidates.sort((a, b) =>
    a.element.compareDocumentPosition(b.element) &
    Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1
  )
  return candidates[0]?.editor
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  const { target } = event
  const typed = isTypedCharacter({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altGraph: event.getModifierState("AltGraph"),
    isComposing: event.isComposing,
    targetActivatesOnSpace:
      target instanceof HTMLElement &&
      Boolean(target.closest(activatesOnSpaceSelector)),
  })
  if (!typed || isFieldOrMenuTarget(target)) return
  const editor = typingEditor()
  if (!editor) return
  // The key is not cancelled: the browser inserts it where the focus now is,
  // which keeps dead keys and IME compositions working.
  editor.focusAtEnd()
  // "/" is left to the Chat's own shortcut, which focuses the composer
  // without typing the character.
  if (event.key !== "/") event.stopImmediatePropagation()
}
