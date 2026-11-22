import * as React from "react"
import {
  BlocksIcon,
  GitPullRequestIcon,
  RouteIcon,
  WorkflowIcon,
} from "lucide-react"
import { AgentConversationComposer } from "@/components/chat/agent-conversation"
import { PreviewLaunchClouds } from "@/components/backlog/drawer/preview-idle-state"
import { ConversationSurface } from "@/components/chat/conversation-surface"
import { ConversationEmptyState } from "@/components/chat/quick-chat-empty-state"
import { ModelSelector } from "@/components/model/model-selector"
import {
  composerDraftStorageKey,
  writeComposerDraft,
} from "@/components/backlog/drawer/composer-draft-storage"
import { useEpicDraft } from "./use-epic-draft"
import { toast } from "sonner"

import {
  epicTitleFromGoal,
  wholeModelRange,
  type Epic,
  type EpicSettings,
} from "@/components/orchestrator/data/epic-data"
import { useEpicStore } from "@/components/orchestrator/data/epic-store"
import { useEpicModels } from "@/components/orchestrator/data/use-epic-models"
import { useEpicMessenger } from "@/components/orchestrator/data/use-epic-conversation"
import { AppLink } from "@/components/navigation/app-link"
import { useProjectInitialization } from "@/components/project-initialization/use-project-initialization"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

const suggestions = [
  {
    icon: BlocksIcon,
    label: "Build a feature",
    prompt: "Build a feature that lets people ",
  },
  {
    icon: RouteIcon,
    label: "Plan a migration",
    prompt: "Migrate this project from ",
  },
  {
    icon: GitPullRequestIcon,
    label: "Refactor a module",
    prompt: "Refactor the following module while preserving its behavior: ",
  },
] as const

export function NewEpic({
  projectId,
  onCreated,
}: {
  projectId: string
  onCreated: (epic: Epic) => void
}) {
  const epics = useEpicStore()
  const platform = usePlatform()
  const project = useProjects().activeProject
  const models = useEpicModels()
  const messenger = useEpicMessenger()
  const initialization = useProjectInitialization()
  // The host refuses to create an epic's stories without a working preview
  // environment (they would run Direct, not on the epic's branch): the same
  // condition as its `initializationDecision`, said before the goal.
  const noPreviewEnvironment = initialization?.availability === "unavailable"
  const draft = useEpicDraft(projectId)
  const goal = draft.message.text
  const [creating, setCreating] = React.useState(false)
  const title = epicTitleFromGoal(goal)

  async function start() {
    if (!title || creating || noPreviewEnvironment) return
    setCreating(true)
    try {
      const epic = await epics.create({
        goal: goal.trim(),
        settings: defaultSettings(models),
        targetBranch: await currentBranch(platform, project?.path),
        title,
      })
      // Keep the goal and its attachments available in the epic if delivery fails.
      let delivered = false
      try {
        if (!messenger.unavailable(epic)) {
          await messenger.deliver(epic, draft.message)
          delivered = true
        }
      } finally {
        if (!delivered)
          writeComposerDraft(
            localStorage,
            composerDraftStorageKey(projectId, "epic", epic.id),
            {
              markdown: goal,
              codeSelectionAttachments: draft.message.codeSelectionAttachments,
              fileAttachments: draft.message.fileAttachments,
            }
          )
        draft.clear()
        onCreated(epic)
      }
    } catch (error) {
      toast.error("Unable to start the epic", {
        description: error instanceof Error ? error.message : String(error),
        position: "bottom-right",
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ConversationSurface
        background={
          <div
            aria-hidden="true"
            className="epic-clouds"
            data-visible={
              !goal &&
              !draft.message.fileAttachments.length &&
              !draft.message.codeSelectionAttachments.length
            }
          >
            <PreviewLaunchClouds filling={false} />
          </div>
        }
        emptyState={
          <ConversationEmptyState
            icon={WorkflowIcon}
            title="What should this epic achieve?"
            description="Give the orchestrator a goal. It plans the user stories, coordinates their agents, and brings the work together on a branch for you to review."
            suggestions={suggestions}
            onSuggestion={
              noPreviewEnvironment || creating
                ? undefined
                : draft.applySuggestion
            }
          />
        }
        composer={
          <div className="grid gap-3">
            {noPreviewEnvironment ? (
              <p
                className="rounded-lg border border-amber-500/35 bg-background/90 px-3 py-2.5 text-sm"
                role="status"
              >
                An epic needs this project’s preview environment to run its
                stories.{" "}
                <AppLink
                  className="font-medium underline underline-offset-4"
                  href="/initialization"
                >
                  Set up the preview environment
                </AppLink>
              </p>
            ) : null}
            <AgentConversationComposer
              {...draft.composer}
              disabled={!project || noPreviewEnvironment}
              submitting={creating}
              submitDisabled={!title}
              mentionDirectory={project?.path}
              minHeight="min-h-44"
              onMessageSubmit={() => void start()}
              placeholder="Describe the outcome you want to build together…"
              submitLabel="Start epic"
              toolbarEnd={<ModelSelector role="agent" />}
            />
          </div>
        }
      />
    </main>
  )
}

function defaultSettings(
  models: ReturnType<typeof useEpicModels>
): EpicSettings {
  const model = models.currentModel
  return {
    askBeforeLaunch: false,
    hiddenModels: models.hiddenModels(),
    modelRange: { ...wholeModelRange },
    providers: [],
    ...(model
      ? {
          orchestratorModel: {
            providerId: model.provider.id,
            modelId: model.id,
            ...(model.credentialLabel
              ? { credentialLabel: model.credentialLabel }
              : {}),
            ...(models.currentVariant
              ? { reasoning: models.currentVariant }
              : {}),
          },
        }
      : {}),
  }
}

// The epic merges where the project folder is now.
async function currentBranch(
  platform: ReturnType<typeof usePlatform>,
  root: string | undefined
) {
  if (!root || !platform.workspace?.gitBranches) return null
  try {
    return (await platform.workspace.gitBranches({ root })).current
  } catch {
    return null
  }
}
