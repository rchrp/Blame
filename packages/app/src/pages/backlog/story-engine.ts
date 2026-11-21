// A story's agent on Blame's engine (docs/engine-in-the-app.md): what the
// renderer decides about it (its settings, the person's messages). The
// story service in the engine host starts it and writes its agent fields.

import type {
  DevelopmentStorySettings,
  EngineLocation,
  EngineMessage,
  EngineSessionSettings,
  StoryWorkspaceMode,
} from "@blame/agent-runtime/engine-protocol"

import type {
  UserStory,
  UserStoryAgentModel,
  UserStoryCodeSelectionAttachment,
  UserStoryFileAttachment,
} from "@/components/backlog/data/backlog-data"
import { codeSelectionLineLabel } from "../../components/backlog/shared/comment-attachment-events.ts"

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

export const storyResumeMessage =
  "Continue the story where you left off: check what is already done in the worktree before going on."
