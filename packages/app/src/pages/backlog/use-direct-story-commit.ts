import * as React from "react"
import type { DirectStoryFile } from "@blame/agent-runtime"
import { toast } from "sonner"

import type {
  UserStory,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import type { useModelSelection } from "@/components/model/model-selection"
import { navigate } from "@/components/navigation/navigation"
import type { useCloudAuth } from "@/context/cloud-auth"
import type { useGitIdentity } from "@/context/git-identity"
import type { usePlatform } from "@/context/platform"
import type { useProjects } from "@/context/projects"
import { celebrateStory } from "@/lib/celebrate"
import { projectCodePractices } from "@/lib/project-code-practices"
import type { DirectSharedFilesDialogProps } from "./direct-shared-files-dialog"
import {
  commitDirectStory,
  directCommitMessageRequest,
  directCommitValidationError,
  type SharedFilesChoice,
} from "./direct-story-commit"
import { inactiveStoryFields } from "./story-runtime-state"

type DirectStoryCommitInput = {
  alternativeSelection: ReturnType<typeof useModelSelection>
  auth: ReturnType<typeof useCloudAuth>
  gitIdentity: ReturnType<typeof useGitIdentity>
  platform: ReturnType<typeof usePlatform>
  projects: ReturnType<typeof useProjects>
  updateStory: (story: UserStory, input: UserStoryUpdate) => Promise<UserStory>
}

type SharedFilesQuestion = Pick<DirectSharedFilesDialogProps, "files" | "open">

// Approve & Commit for a Direct story: commits the files the story wrote, with
// a message the agent writes, then marks the story done. A story whose files
// cannot be committed stays in review with the reason.
export function useDirectStoryCommit({
  alternativeSelection,
  auth,
  gitIdentity,
  platform,
  projects,
  updateStory,
}: DirectStoryCommitInput) {
  const [question, setQuestion] = React.useState<SharedFilesQuestion>()
  const answer = React.useRef<(choice: SharedFilesChoice) => void>(undefined)

  const confirmSharedFiles = React.useCallback(
    (files: DirectStoryFile[]) =>
      new Promise<SharedFilesChoice>((resolve) => {
        answer.current = resolve
        setQuestion({ files, open: true })
      }),
    []
  )
  const chooseSharedFiles = React.useCallback((choice: SharedFilesChoice) => {
    answer.current?.(choice)
    answer.current = undefined
    setQuestion((current) => current && { ...current, open: false })
  }, [])
  // A page that closes with the question open commits nothing.
  React.useEffect(() => () => answer.current?.("cancel"), [])

  const approveAndCommitDirectStory = React.useCallback(
    async (story: UserStory) => {
      const model = alternativeSelection.currentModel
      const validationError = directCommitValidationError(
        story,
        auth.status,
        platform.agent,
        platform.workspace,
        model
      )
      if (validationError) {
        toast.error("Unable to approve and commit", {
          description: validationError,
          position: "bottom-right",
        })
        return story
      }
      try {
        const codePractices = await projectCodePractices(auth, projects)
        const root = story.worktree!
        const result = await commitDirectStory(story, root, {
          agent: platform.agent!,
          confirmSharedFiles,
          generateMessage: async (paths) =>
            (
              await platform.agent!.generateCommitMessage({
                apiConnection: auth.apiConnection,
                providerId: model!.provider.id,
                modelId: model!.id,
                credentialLabel: model!.credentialLabel,
                reasoningEffort: alternativeSelection.currentVariant,
                ...directCommitMessageRequest(story, root, paths),
                codePractices,
              })
            ).message,
          workspace: platform.workspace!,
        })
        if (result.status === "cancelled") return story
        const doneStory = await updateStory(story, {
          ...inactiveStoryFields(),
          agentLastError: null,
          agentLastEvent: `Committed ${result.commit.slice(0, 7)}.`,
          baseCommit: result.baseCommit,
          mergeCommit: result.commit,
          mergedAt: new Date().toISOString(),
          status: "done",
        })
        celebrateStory(story.id)
        toast.success("Story committed", {
          action: { label: "Open Git", onClick: () => navigate("/git") },
          description: `${result.fileCount} ${
            result.fileCount === 1 ? "file" : "files"
          }: ${result.message.split("\n")[0]}`,
          position: "bottom-right",
        })
        return doneStory
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Git asking who you are gets its dialog, not a raw error.
        const askedIdentity = gitIdentity?.handleError(message, () =>
          toast.success("Git name and email saved", {
            description: "Approve & Commit again to commit the story.",
            position: "bottom-right",
          })
        )
        if (!askedIdentity)
          toast.error("Approve & Commit failed", {
            description: message,
            position: "bottom-right",
          })
        return updateStory(story, {
          agentLastError: message,
          agentLastEvent: message,
        })
      }
    },
    [
      alternativeSelection.currentModel,
      alternativeSelection.currentVariant,
      auth,
      confirmSharedFiles,
      gitIdentity,
      platform,
      projects,
      updateStory,
    ]
  )

  return {
    approveAndCommitDirectStory,
    sharedFilesDialog: {
      files: question?.files ?? [],
      onChoose: chooseSharedFiles,
      open: question?.open ?? false,
    } satisfies DirectSharedFilesDialogProps,
  }
}
