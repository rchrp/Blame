import { loadPrompt } from "./prompt-loader.js";

// How the person wants their agents to talk and work. Each setting has three
// notches and the middle one is the default, which adds nothing to what the
// agent is told. These settings only change instructions: never tool
// permissions, sandboxing, the model, reasoning or iteration limits.
export type ResponseStyle = "concise" | "balanced" | "detailed";
export type Experience = "new" | "comfortable" | "experienced";
export type Autonomy = "ask" | "balanced" | "decide";
export type Ambition = "quick" | "standard" | "ambitious";

export type AgentPersonalization = {
  responseStyle: ResponseStyle;
  experience: Experience;
  autonomy: Autonomy;
  ambition: Ambition;
};

export const defaultPersonalization: Readonly<AgentPersonalization> = {
  responseStyle: "balanced",
  experience: "comfortable",
  autonomy: "balanced",
  ambition: "standard",
};

const responseStyles: readonly ResponseStyle[] = [
  "concise",
  "balanced",
  "detailed",
];
const experiences: readonly Experience[] = [
  "new",
  "comfortable",
  "experienced",
];
const autonomies: readonly Autonomy[] = ["ask", "balanced", "decide"];
const ambitions: readonly Ambition[] = ["quick", "standard", "ambitious"];

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return allowed.find((item) => item === value) ?? fallback;
}

// Input from outside the runtime: a missing or unknown value is the default.
export function normalizePersonalization(
  value?: Partial<Record<keyof AgentPersonalization, unknown>> | null,
): AgentPersonalization {
  return {
    responseStyle: oneOf(
      responseStyles,
      value?.responseStyle,
      defaultPersonalization.responseStyle,
    ),
    experience: oneOf(
      experiences,
      value?.experience,
      defaultPersonalization.experience,
    ),
    autonomy: oneOf(
      autonomies,
      value?.autonomy,
      defaultPersonalization.autonomy,
    ),
    ambition: oneOf(
      ambitions,
      value?.ambition,
      defaultPersonalization.ambition,
    ),
  };
}

export function samePersonalization(
  left: AgentPersonalization,
  right: AgentPersonalization,
) {
  return (
    left.responseStyle === right.responseStyle &&
    left.experience === right.experience &&
    left.autonomy === right.autonomy &&
    left.ambition === right.ambition
  );
}

// Goes in the description of finish_task, not in the system prompt.
export function responseStyleBlock(style: ResponseStyle) {
  return style === "balanced"
    ? ""
    : loadPrompt(`personalization/response-style-${style}`);
}

// The blocks for the system prompt: empty when all three are the default.
export function workStyleBlocks(
  personalization: Pick<
    AgentPersonalization,
    "experience" | "autonomy" | "ambition"
  >,
) {
  const { experience, autonomy, ambition } = personalization;
  return [
    experience === "comfortable"
      ? ""
      : loadPrompt(`personalization/experience-${experience}`),
    autonomy === "balanced"
      ? ""
      : loadPrompt(`personalization/autonomy-${autonomy}`),
    ambition === "standard"
      ? ""
      : loadPrompt(`personalization/ambition-${ambition}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// What the system prompt says about the personalization; "" for the defaults.
export function personalizationSystemSection(
  personalization: AgentPersonalization,
) {
  const blocks = workStyleBlocks(personalization);
  return blocks ? `## Personalization\n\n${blocks}` : "";
}

// The system prompt is fixed once a session runs, so a change made between
// two turns reaches the agent as a note ahead of the next message. Empty when
// nothing changed.
export function personalizationUpdateNote(
  previous: AgentPersonalization,
  next: AgentPersonalization,
) {
  if (samePersonalization(previous, next)) return "";
  const blocks = [
    responseStyleBlock(next.responseStyle),
    workStyleBlocks(next),
  ].filter(Boolean);
  const listing = blocks.length
    ? blocks.join("\n\n")
    : "None: every setting is back to its default.";
  return loadPrompt("personalization/update").replace(
    "{{BLOCKS}}",
    () => listing,
  );
}
