import type {
  EngineModelChoice,
  EnginePlatformClient,
  GenerateTitleTask,
} from "@blame/agent-runtime/engine-protocol"

import type { useModelSelection } from "@/components/model/model-selection"

export type AgentTitleGenerationInput = Omit<GenerateTitleTask, "workspace"> & {
  workspace: string
}

/** The model of the selector, as engine tasks take it. */
export function engineModelChoice(
  selection: Pick<
    ReturnType<typeof useModelSelection>,
    "currentModel" | "currentVariant"
  >
): EngineModelChoice | undefined {
  const model = selection.currentModel
  if (!model) return undefined
  return {
    providerId: model.provider.id,
    modelId: model.id,
    credentialLabel: model.credentialLabel,
    reasoning: selection.currentVariant,
  }
}

export async function generateAgentTitle(
  engine: Pick<EnginePlatformClient, "call">,
  input: AgentTitleGenerationInput
) {
  return (await generateAgentTitleSelection(engine, input)).title
}

// The engine task's result, cleaned once more for the places a title is
// shown: the caller keeps its draft when nothing usable came back.
export async function generateAgentTitleSelection(
  engine: Pick<EnginePlatformClient, "call">,
  input: AgentTitleGenerationInput
) {
  const result = await engine.call("generateTitle", {
    ...input,
    workspace: { root: input.workspace },
  })
  const title = normalizedAgentTitle(result.title)
  if (!title) throw new Error("Title generator agent did not return a title.")
  return { title, runConfigurationId: result.runConfigurationId }
}

const maxAgentTitleLength = 80

// Empty when the generator's answer is not a title: tags, JSON or a
// transcript line mean the model wrote a tool call or other scaffolding as
// text, and the caller keeps its draft title.
export function normalizedAgentTitle(title: string) {
  const value = title.trim()
  if (/<[/!?]?[a-z_]|[{}]|^\[|[─-╿]/iu.test(value)) return ""
  const normalized = value
    .replace(/[.!?:;]+$/g, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
  return normalized.length > maxAgentTitleLength ? "" : normalized
}
