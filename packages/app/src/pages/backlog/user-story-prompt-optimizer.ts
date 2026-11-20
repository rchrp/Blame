import { toast } from "sonner"

import type { useModelSelection } from "@/components/model/model-selection"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { usePlatform } from "@/context/platform"
import { engineModelChoice } from "@/lib/agent-title-generation"

function optimizeUserStoryValidationError(
  summary: string,
  auth: ReturnType<typeof useCloudAuth>,
  platform: ReturnType<typeof usePlatform>,
  repositoryRoot: string | undefined,
  model: unknown
) {
  if (!summary.trim()) return "Write a user story before optimizing it."
  if (!repositoryRoot) return "Unable to resolve the active project."
  if (auth.status !== "authenticated")
    return "Reconnect the provider before optimizing the user story."
  if (!model) return "Select a model before optimizing the user story."
  if (!platform.engine) return "Blame's agent engine is not available."
}

type OptimizeUserStoryPromptRequest = {
  input: {
    summary: string
    title: string
  }
  auth: ReturnType<typeof useCloudAuth>
  platform: ReturnType<typeof usePlatform>
  projectPath?: string
  model: ReturnType<typeof useModelSelection>["currentModel"]
  reasoningEffort: ReturnType<typeof useModelSelection>["currentVariant"]
}

export async function optimizeUserStoryPrompt(
  request: OptimizeUserStoryPromptRequest
) {
  const validationError = optimizeUserStoryValidationError(
    request.input.summary,
    request.auth,
    request.platform,
    request.projectPath,
    request.model
  )
  if (validationError) throw optimizationValidationError(validationError)
  const toastId = "user-story-prompt-optimizer"
  toast.loading("Optimizing user story", {
    id: toastId,
    position: "bottom-right",
  })
  try {
    const result = await runPromptOptimizer(request)
    toast.success("User story optimized", {
      id: toastId,
      position: "bottom-right",
    })
    return result
  } catch (error) {
    toast.error("User story optimization failed", {
      description: errorMessage(error),
      id: toastId,
      position: "bottom-right",
    })
    throw error
  }
}

function optimizationValidationError(message: string) {
  toast.error("Unable to optimize user story", {
    description: message,
    position: "bottom-right",
  })
  return new Error(message)
}

async function runPromptOptimizer(request: OptimizeUserStoryPromptRequest) {
  const result = await request.platform.engine!.call("optimizeUserStory", {
    model: engineModelChoice({
      currentModel: request.model,
      currentVariant: request.reasoningEffort,
    })!,
    prompt: request.input.summary,
    title: request.input.title,
    workspace: { root: request.projectPath! },
  })
  return result.markdown
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
