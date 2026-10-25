export type NewProjectMode = "manual" | "ai"
export type NewProjectStep =
  | "location"
  | "mode"
  | "assistant"
  | "platform"
  | "frontend"
  | "styling"
  | "backend"
  | "data"
  | "quality"
  | "advanced"
  | "summary"
  | "progress"

export function newProjectSteps(mode?: NewProjectMode): NewProjectStep[] {
  const start: NewProjectStep[] = ["location", "mode"]
  if (!mode) return start
  return mode === "ai"
    ? [...start, "assistant", "summary"]
    : [
        ...start,
        "platform",
        "frontend",
        "styling",
        "backend",
        "data",
        "quality",
        "advanced",
        "summary",
      ]
}
