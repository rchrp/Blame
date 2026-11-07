import type {
  AgentPersonalization,
  Ambition,
  Autonomy,
  Experience,
  ResponseStyle,
} from "@blame/agent-runtime"

export type Personalization = AgentPersonalization
export type PersonalizationSetting = keyof Personalization
export type { Ambition, Autonomy, Experience, ResponseStyle }

// The three notches of a setting; the middle one is the default.
type Notches<Value extends string> = readonly [
  PersonalizationNotch<Value>,
  PersonalizationNotch<Value>,
  PersonalizationNotch<Value>,
]

export type PersonalizationNotch<Value extends string> = {
  value: Value
  label: string
  // How the agent will behave at this notch, in one short sentence.
  description: string
}

export type PersonalizationDefinition<Setting extends PersonalizationSetting> = {
  key: Setting
  label: string
  color: "green" | "violet" | "amber" | "rose"
  notches: Notches<Personalization[Setting]>
}

export const defaultPersonalization: Personalization = {
  responseStyle: "balanced",
  experience: "comfortable",
  autonomy: "balanced",
  ambition: "standard",
}

export const personalizationDefinitions: {
  [Setting in PersonalizationSetting]: PersonalizationDefinition<Setting>
} = {
  responseStyle: {
    key: "responseStyle",
    label: "Response style",
    color: "green",
    notches: [
      {
        value: "concise",
        label: "Concise",
        description: "Short replies: the outcome and what to check.",
      },
      {
        value: "balanced",
        label: "Balanced",
        description: "Replies cover what changed and the checks that ran.",
      },
      {
        value: "detailed",
        label: "Detailed",
        description: "Replies explain what changed, why, and how it was checked.",
      },
    ],
  },
  experience: {
    key: "experience",
    label: "Experience",
    color: "violet",
    notches: [
      {
        value: "new",
        label: "New to coding",
        description:
          "Plain words, terms explained, and your technical hints checked against the code.",
      },
      {
        value: "comfortable",
        label: "Comfortable",
        description:
          "Clear language, and your technical hints taken as a good lead.",
      },
      {
        value: "experienced",
        label: "Experienced",
        description:
          "Technical vocabulary, and your technical hints followed directly.",
      },
    ],
  },
  autonomy: {
    key: "autonomy",
    label: "Autonomy",
    color: "amber",
    notches: [
      {
        value: "ask",
        label: "Ask first",
        description:
          "Asks before structural or risky changes, and explains each step.",
      },
      {
        value: "balanced",
        label: "Balanced",
        description: "Asks when a choice really needs you, and decides the rest.",
      },
      {
        value: "decide",
        label: "Decide and report",
        description: "Decides on its own and tells you what it chose at the end.",
      },
    ],
  },
  ambition: {
    key: "ambition",
    label: "Ambition",
    color: "rose",
    notches: [
      {
        value: "quick",
        label: "Quick",
        description: "Takes the most direct route and stops once it works.",
      },
      {
        value: "standard",
        label: "Standard",
        description: "Goes as deep as the task needs.",
      },
      {
        value: "ambitious",
        label: "Ambitious",
        description:
          "Treats it as production work: researches, compares approaches and iterates. Runs longer.",
      },
    ],
  },
}

export const personalizationOrder: readonly PersonalizationSetting[] = [
  "responseStyle",
  "experience",
  "autonomy",
  "ambition",
]

export function notchIndex(setting: PersonalizationSetting, value: string) {
  const notches: readonly PersonalizationNotch<string>[] =
    personalizationDefinitions[setting].notches
  return Math.max(
    0,
    notches.findIndex((notch) => notch.value === value)
  )
}

export function notchAt<Setting extends PersonalizationSetting>(
  setting: Setting,
  index: number
): PersonalizationNotch<Personalization[Setting]> {
  const notches = personalizationDefinitions[setting].notches
  return notches[Math.min(notches.length - 1, Math.max(0, index))]!
}

// A value read from outside the typed settings, or nothing when it is not
// one of the setting's notches.
export function parseNotch<Setting extends PersonalizationSetting>(
  setting: Setting,
  value: string
) {
  const notches: readonly PersonalizationNotch<string>[] =
    personalizationDefinitions[setting].notches
  return notches.find((notch) => notch.value === value)?.value as
    | Personalization[Setting]
    | undefined
}

// A stored or received value: anything unknown is the default notch.
export function normalizePersonalization(value: unknown): Personalization {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  const known = <Setting extends PersonalizationSetting>(setting: Setting) => {
    const notches: readonly PersonalizationNotch<string>[] =
      personalizationDefinitions[setting].notches
    return notches.some((notch) => notch.value === record[setting])
      ? (record[setting] as Personalization[Setting])
      : defaultPersonalization[setting]
  }
  return {
    responseStyle: known("responseStyle"),
    experience: known("experience"),
    autonomy: known("autonomy"),
    ambition: known("ambition"),
  }
}

// The ambition of a story or conversation: its own, else the account's.
export function effectiveAmbition(
  accountAmbition: Ambition,
  override: Ambition | null | undefined
) {
  return override ?? accountAmbition
}

// What to keep for an ambition chosen in the menu: nothing when it is the
// account's, so that the story or conversation follows the account again.
export function ambitionOverride(
  accountAmbition: Ambition,
  chosen: Ambition
): Ambition | null {
  return chosen === accountAmbition ? null : chosen
}

// What an agent turn is told: the account's settings, with the ambition of
// the story or conversation when it has one.
export function agentPersonalization(
  account: Personalization,
  ambition?: Ambition | null
): Personalization {
  return { ...account, ambition: effectiveAmbition(account.ambition, ambition) }
}

export function samePersonalization(
  left: Personalization,
  right: Personalization
) {
  return personalizationOrder.every((setting) => left[setting] === right[setting])
}
