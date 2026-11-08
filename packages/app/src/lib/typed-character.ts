// Decides whether a keydown is the user typing text, as opposed to a
// shortcut, a navigation key or a key that activates a focused control.

export type KeyDownFacts = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  // AltGr on Windows reports Ctrl and Alt together; it types characters.
  altGraph: boolean
  isComposing: boolean
  // The focused control acts on Space (button, link, checkbox, tab...).
  targetActivatesOnSpace: boolean
}

export function isTypedCharacter({
  altGraph,
  ctrlKey,
  isComposing,
  key,
  metaKey,
  targetActivatesOnSpace,
}: KeyDownFacts) {
  if (isComposing || metaKey || (ctrlKey && !altGraph)) return false
  // A dead key (the "^" of a French keyboard) starts an accented character.
  if (key === "Dead") return true
  if (Array.from(key).length !== 1) return false
  return key !== " " || !targetActivatesOnSpace
}
