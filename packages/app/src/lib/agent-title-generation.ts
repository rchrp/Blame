import type { GenerateTitleInput } from "@blame/agent-runtime"

import type { Platform } from "@/context/platform"

type TitleGenerator = NonNullable<
  Platform["agent"]
>["promptOptimizer"]["generateTitle"]

export type AgentTitleGenerationInput = Omit<
  GenerateTitleInput,
  "cwd" | "workspaceRoot"
> & {
  workspace: string
}

export async function generateAgentTitle(
  generateTitle: TitleGenerator,
  input: AgentTitleGenerationInput
) {
  return (await generateAgentTitleSelection(generateTitle, input)).title
}

export async function generateAgentTitleSelection(
  generateTitle: TitleGenerator,
  input: AgentTitleGenerationInput
) {
  const result = await generateTitle({
    ...input,
    cwd: input.workspace,
    workspaceRoot: input.workspace,
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
