import {
  defaultPersonalization,
  samePersonalization,
  type Personalization,
  type PersonalizationSetting,
} from "./personalization.ts"

type Listener = () => void

export type PersonalizationStore = ReturnType<typeof createPersonalizationStore>

// The account's settings, shared by every place that shows them (the
// composer menu, Settings): a change shows everywhere at once, and goes back
// to what the account has if it cannot be saved.
export function createPersonalizationStore(
  initial: Personalization = defaultPersonalization
) {
  let value = initial
  // What the account is known to hold.
  let saved = initial
  let changes = 0
  let saving = 0
  const listeners = new Set<Listener>()

  function show(next: Personalization) {
    if (samePersonalization(value, next)) return
    value = next
    listeners.forEach((listener) => listener())
  }

  return {
    get: () => value,
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // The account's settings as the app received them. A change still being
    // saved is not overwritten by an older state.
    hydrate(account: Personalization) {
      saved = account
      if (saving === 0) show(account)
    },
    async change<Setting extends PersonalizationSetting>(
      setting: Setting,
      next: Personalization[Setting],
      save: (personalization: Personalization) => Promise<void>
    ) {
      if (value[setting] === next) return
      const personalization = { ...value, [setting]: next }
      const change = ++changes
      saving += 1
      show(personalization)
      try {
        await save(personalization)
        saved = personalization
      } catch (error) {
        // Only the latest change goes back: a later one has its own outcome.
        if (change === changes) show(saved)
        throw error
      } finally {
        saving -= 1
      }
    },
  }
}

export const personalizationStore = createPersonalizationStore()
