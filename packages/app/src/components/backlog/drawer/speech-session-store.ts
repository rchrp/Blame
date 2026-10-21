// Where a dictation ends up: the editor it started in, and the saved draft
// behind that editor so the text survives when the editor is gone.
export type SpeechTarget = {
  draftKey?: string
  label: string
}

export type SpeechSlot = {
  // The editor's text, to avoid inserting a dictation it already holds.
  currentText?: () => string
  element: HTMLElement
  onTranscription: (text: string) => void
  target?: SpeechTarget
  visible: boolean
}

type SpeechSessionOptions = {
  // Appends a dictation to a saved draft while its editor is closed.
  appendToDraft?: (draftKey: string, text: string) => void
}

class SpeechSessionStore {
  private slots = new Map<string, SpeechSlot>()
  private targets = new Map<string, SpeechTarget>()
  private pending = new Map<string, string[]>()
  private listeners = new Set<() => void>()
  private version = 0
  private options: SpeechSessionOptions

  constructor(options: SpeechSessionOptions = {}) {
    this.options = options
  }

  snapshot = () => this.version

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  slot(key: string) {
    return this.slots.get(key)
  }

  // Remembered after its editor closes, so the floating recorder can say
  // where the text goes.
  target(key: string) {
    return this.slots.get(key)?.target ?? this.targets.get(key)
  }

  register(key: string, slot: SpeechSlot) {
    this.slots.set(key, slot)
    if (slot.target) this.targets.set(key, slot.target)
    this.notify()
    return () => {
      if (this.slots.get(key) !== slot) return
      this.slots.delete(key)
      this.notify()
    }
  }

  flush(key: string) {
    const slot = this.slots.get(key)
    const texts = this.pending.get(key)
    if (!slot || !texts?.length) return
    this.pending.delete(key)
    // The editor may have reloaded its saved draft, dictation included.
    const current = slot.currentText?.() ?? ""
    const missing = texts.filter((text) => !current.includes(text))
    if (missing.length) slot.onTranscription(missing.join(" "))
  }

  visibility(key: string, visible: boolean) {
    const slot = this.slots.get(key)
    if (!slot || slot.visible === visible) return
    slot.visible = visible
    this.notify()
  }

  // Returns whether the text reached an open editor.
  deliver(key: string, text: string) {
    const slot = this.slots.get(key)
    if (slot) {
      slot.onTranscription(text)
      return true
    }
    this.pending.set(key, [...(this.pending.get(key) ?? []), text])
    const draftKey = this.targets.get(key)?.draftKey
    if (draftKey) this.options.appendToDraft?.(draftKey, text)
    return false
  }

  private notify() {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }
}

export function createSpeechSessionStore(options?: SpeechSessionOptions) {
  return new SpeechSessionStore(options)
}
