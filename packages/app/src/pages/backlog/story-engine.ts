// A story's agent on Blame's engine (docs/engine-in-the-app.md): what the
// renderer decides about it (its settings, the person's messages) and what
// the end of a turn means for the story. The conversation itself is the
// engine session's records; the API keeps only `engineSessionId`,
// `agentStatus`, `agentLastError` and `agentModels`, written here.

import type {
  DevelopmentStorySettings,
  EngineLocation,
  EngineMessage,
  EngineSessionSettings,
  StoryWorkspaceMode,
} from "@blame/agent-runtime/engine-protocol"
import type { TurnOutcome } from "@blame/engine-client"

import type {
  UserStory,
  UserStoryAgentModel,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { codeSelectionLineLabel } from "../../components/backlog/shared/comment-attachment-events.ts"
import { unverifiedChecks } from "@blame/engine-client/transcript"
import { unfinishedTurnText } from "../../components/chat/engine/transcript-conversation.ts"

/**
 * Where a story's worktree is, so its agent runs on the engine next to it. A
 * local-container worktree lives in the Blame Runtime VM on macOS and
 * Windows (on Linux, on the host).
 */
export function storyLocation(
  workspaceMode: StoryWorkspaceMode,
  platformName: string | undefined
): EngineLocation {
  return workspaceMode === "local-container" && platformName !== "linux"
    ? "vm"
    : "host"
}

export type StorySettingsInput = {
  story: Pick<
    UserStory,
    "id" | "projectId" | "title" | "worktree" | "workspaceMode"
  > &
    Partial<Pick<UserStory, "runConfigurationId">>
  model: DevelopmentStorySettings["model"]
  maxContextTokens?: number
  personalization?: DevelopmentStorySettings["personalization"]
  codePractices?: DevelopmentStorySettings["codePractices"]
  previewDevtoolsScope?: string
  /** The project's saved preview environment: it decides the preview tools. */
  initialization?: {
    previewManifest: unknown
    runConfigurations: unknown[]
  } | null
  platformName?: string
}

export function storySessionSettings(
  input: StorySettingsInput
): EngineSessionSettings {
  const { story } = input
  if (!story.worktree) throw new Error("The story has no worktree yet.")
  const workspaceMode = story.workspaceMode ?? "direct"
  return {
    purpose: "development-story",
    settings: {
      workspace: {
        root: story.worktree,
        location: storyLocation(workspaceMode, input.platformName),
      },
      workspaceMode,
      projectId: story.projectId,
      storyId: story.id,
      title: story.title,
      model: input.model,
      ...(input.maxContextTokens
        ? { maxContextTokens: input.maxContextTokens }
        : {}),
      ...(input.personalization
        ? { personalization: input.personalization }
        : {}),
      ...(input.codePractices ? { codePractices: input.codePractices } : {}),
      ...(input.previewDevtoolsScope
        ? { previewDevtoolsScope: input.previewDevtoolsScope }
        : {}),
      ...(input.initialization
        ? {
            projectInitialization: {
              previewManifest: input.initialization.previewManifest,
              runConfigurations: input.initialization.runConfigurations,
              ...(story.runConfigurationId
                ? { runConfigurationId: story.runConfigurationId }
                : {}),
            } as NonNullable<DevelopmentStorySettings["projectInitialization"]>,
          }
        : {}),
    },
  }
}

/** The models list with this one last (the card shows them; the next turn reuses the last). */
export function withAgentModel(
  models: UserStoryAgentModel[] | null | undefined,
  model: UserStoryAgentModel
): UserStoryAgentModel[] {
  const others = (models ?? []).filter(
    (item) =>
      item.providerId !== model.providerId ||
      item.modelId !== model.modelId ||
      (item.reasoningEffort ?? null) !== (model.reasoningEffort ?? null)
  )
  return [...others, model].slice(-16)
}

/**
 * A message to the story's agent: the text, code excerpts quoted in it,
 * and attached files read as the model gets them (images, PDFs, text).
 */
export async function storyMessage(
  text: string,
  codeSelections: UserStoryCodeSelectionAttachment[] | null | undefined,
  files: UserStoryFileAttachment[] | null | undefined,
  readFile: (file: UserStoryFileAttachment) => Promise<string | undefined>
): Promise<EngineMessage> {
  const excerpts = (codeSelections ?? [])
    .filter((excerpt) => excerpt.origin !== "story")
    .map(
      (excerpt) =>
        `${excerpt.path}, ${codeSelectionLineLabel(excerpt).toLowerCase()}:\n\n\`\`\`\n${excerpt.content}\n\`\`\``
    )
  const stories = (codeSelections ?? [])
    .filter((excerpt) => excerpt.origin === "story")
    .map((excerpt) => `Builds on ${excerpt.path}: ${excerpt.content}`)
  const attachments: EngineMessage["attachments"] = []
  for (const file of files ?? []) {
    const data = file.content ?? (await readFile(file))
    if (data)
      attachments.push({
        data,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
      })
  }
  return {
    text: [text.trim(), ...excerpts, ...stories].filter(Boolean).join("\n\n"),
    attachments,
  }
}

/**
 * What the end of every turn of a story's agent means for the story:
 * done, it waits for review; stopped (by the person, by a limit, by Blame
 * quitting), it is paused where it was; failed, it goes to review with the
 * error in its conversation, except a sign-in problem, which pauses it.
 */
export function storyOutcomeUpdate(
  story: Pick<UserStory, "status">,
  outcome: TurnOutcome | undefined
): UserStoryUpdate {
  if (story.status !== "in-progress") return { agentStatus: null }
  switch (outcome?.status) {
    case "completed":
      return { agentStatus: null, status: "in-review" }
    // The engine already retried what could be retried: the story waits for
    // the person, with the reason, and resumes from its records.
    case "failed":
      return { agentStatus: "Paused", agentLastError: outcome.error.message }
    // The agent stopped without a finish the checks accepted. When they
    // refused it because a check still fails, its reply stands, unverified,
    // and the story waits for review as before; otherwise it is paused.
    case "contract_unmet":
      return unverifiedChecks({ outcome })
        ? { agentStatus: null, status: "in-review" }
        : { agentStatus: "Paused", agentLastError: unfinishedTurnText }
    default:
      return { agentStatus: "Paused" }
  }
}

export const storyResumeMessage =
  "Continue the story where you left off: check what is already done in the worktree before going on."
