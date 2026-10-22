import * as React from "react"
import { toast } from "sonner"

import { createBacklogApi } from "@/components/backlog/data/backlog-api"
import {
  mergeLoadedStories,
  mergeStoryAgentRun,
  mergeUserStory,
} from "@/components/backlog/data/backlog-store-merge"
import type {
  BacklogColumnId,
  UserStory,
  UserStoryAgentActivity,
  UserStoryAgentRun,
  UserStoryAgentRunDraft,
  UserStoryAgentRunFinalization,
  UserStoryAgentRunUpdate,
  UserStoryComment,
  UserStoryDraft,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { useProjects } from "@/context/projects"
import { recordPerformanceCount } from "@/lib/performance-diagnostics"

type BacklogState = {
  cleanupStoryIds: Set<string>
  detailedStoryIds: Set<string>
  error?: string
  loading: boolean
  projectId?: string
  setupInitializingStoryIds: Set<string>
  stories: UserStory[]
}

type BacklogStoreValue = ReturnType<typeof useBacklogStoreValue>

const BacklogStoreContext = React.createContext<BacklogStoreValue | undefined>(
  undefined
)

export function BacklogStoreProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const value = useBacklogStoreValue()

  return React.createElement(BacklogStoreContext.Provider, { value }, children)
}

export function useBacklogStore() {
  const context = React.useContext(BacklogStoreContext)
  if (!context)
    throw new Error("useBacklogStore must be used within BacklogStoreProvider")
  return context
}

function useBacklogStoreValue() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const [state, setState] = React.useState<BacklogState>({
    cleanupStoryIds: new Set(),
    detailedStoryIds: new Set(),
    loading: false,
    setupInitializingStoryIds: new Set(),
    stories: [],
  })
  const loadRequestId = React.useRef(0)
  const detailRequests = React.useRef(new Map<string, Promise<UserStory>>())
  const updateQueues = React.useRef(new Map<string, Promise<unknown>>())
  const projectId = projects.activeProject?.id
  const projectPath = projects.activeProject?.path

  const api = React.useMemo(
    () => createBacklogApi(auth.apiConnection, platform.agentScreenshots),
    [auth.apiConnection, platform.agentScreenshots]
  )

  const load = React.useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (!projectId) {
      setState({
        cleanupStoryIds: new Set(),
        detailedStoryIds: new Set(),
        loading: false,
        projectId: undefined,
        setupInitializingStoryIds: new Set(),
        stories: [],
      })
      return
    }
    setState((current) => loadingState(current, projectId))
    try {
      const loadedStories = await api.list(projectId)
      if (loadRequestId.current !== requestId) return
      setState((current) => ({
        ...current,
        error: undefined,
        loading: false,
        projectId,
        stories: mergeLoadedStories(current.stories, loadedStories),
      }))
    } catch (error) {
      if (loadRequestId.current !== requestId) return
      setState({
        cleanupStoryIds: new Set(),
        error:
          error instanceof Error
            ? error.message
            : "Unable to load user stories.",
        loading: false,
        projectId,
        detailedStoryIds: new Set(),
        setupInitializingStoryIds: new Set(),
        stories: [],
      })
    }
  }, [api, projectId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      loadRequestId.current += 1
    }
  }, [load])

  const create = React.useCallback(
    async (input: Omit<UserStoryDraft, "projectId">) => {
      if (!projectId)
        throw new Error("Open a project before creating a user story.")
      const creation = await api.create({ ...input, projectId })
      const story = creation.story
      setState((current) => ({
        ...current,
        detailedStoryIds: storyStateIds(
          current.detailedStoryIds,
          story.id,
          true
        ),
        stories: [...current.stories, story],
      }))
      if ("completeAttachmentUpload" in creation) {
        runCreatedStoryAttachmentUpload(
          story,
          creation.completeAttachmentUpload,
          setState
        )
      }
      return story
    },
    [api, projectId]
  )

  const update = React.useCallback(
    (story: UserStory, input: UserStoryUpdate) =>
      enqueueStoryRequest(updateQueues, story.id, async () => {
        const nextStory = await api.update(story.id, input)
        setState((current) => ({
          ...current,
          detailedStoryIds: storyStateIds(
            current.detailedStoryIds,
            nextStory.id,
            true
          ),
          stories: current.stories.map((currentStory) =>
            currentStory.id === story.id
              ? mergeUserStory(currentStory, nextStory, {
                  replaceAgentActivities: input.agentActivities !== undefined,
                })
              : currentStory
          ),
        }))
        return nextStory
      }),
    [api]
  )
  const undoComment = React.useCallback(
    async (
      story: UserStory,
      commentId: string,
      input: { clineSessionId?: string; runId: string }
    ) => {
      const nextStory = await api.undoComment(story.id, commentId, input)
      replaceStory(nextStory, setState)
      return nextStory
    },
    [api]
  )
  const validateCommentUndo = React.useCallback(
    (story: UserStory, commentId: string, runId: string) =>
      api.validateCommentUndo(story.id, commentId, runId),
    [api]
  )
  const createComment = React.useCallback(
    async (
      story: UserStory,
      input: Pick<
        UserStoryComment,
        "body" | "codeSelectionAttachments" | "fileAttachments"
      >
    ) => {
      const comment = await api.createComment(story.id, input)
      setState((current) => ({
        ...current,
        detailedStoryIds: storyStateIds(
          current.detailedStoryIds,
          story.id,
          true
        ),
        stories: current.stories.map((currentStory) =>
          currentStory.id === story.id
            ? storyWithComment(currentStory, comment)
            : currentStory
        ),
      }))
      return comment
    },
    [api]
  )
  const createAgentRun = React.useCallback(
    async (story: UserStory, input: UserStoryAgentRunDraft) => {
      const run = await api.createAgentRun(story.id, input)
      setState((current) => ({
        ...current,
        detailedStoryIds: storyStateIds(
          current.detailedStoryIds,
          story.id,
          true
        ),
        stories: current.stories.map((currentStory) =>
          currentStory.id === story.id
            ? storyWithActiveAgentRun(currentStory, run)
            : currentStory
        ),
      }))
      return run
    },
    [api]
  )
  const updateAgentRun = React.useCallback(
    async (
      story: UserStory,
      run: UserStoryAgentRun,
      input: UserStoryAgentRunUpdate
    ) => {
      const nextRun = await api.updateAgentRun(story.id, run.id, input)
      setState((current) => ({
        ...current,
        stories: current.stories.map((currentStory) =>
          currentStory.id === story.id
            ? mergeStoryAgentRun(currentStory, nextRun)
            : currentStory
        ),
      }))
      return nextRun
    },
    [api]
  )
  const finalizeAgentRun = React.useCallback(
    (
      story: UserStory,
      run: UserStoryAgentRun,
      input: UserStoryAgentRunFinalization
    ) =>
      enqueueStoryRequest(updateQueues, story.id, async () => {
        const nextStory = await api.finalizeAgentRun(story.id, run.id, input)
        setState((current) => ({
          ...current,
          detailedStoryIds: storyStateIds(
            current.detailedStoryIds,
            story.id,
            true
          ),
          stories: current.stories.map((currentStory) =>
            currentStory.id === story.id
              ? mergeUserStory(currentStory, nextStory, {
                  replaceAgentActivities: true,
                })
              : currentStory
          ),
        }))
        return nextStory
      }),
    [api]
  )
  const updateAgentLocal = React.useCallback(
    (
      story: UserStory,
      input: UserStoryUpdate,
      run?: UserStoryAgentRun,
      runInput?: UserStoryAgentRunUpdate
    ) => {
      recordPerformanceCount("backlog.store.update_agent_local")
      React.startTransition(() => {
        setState((current) => ({
          ...current,
          stories: current.stories.map((currentStory) =>
            storyWithLocalAgentUpdate(currentStory, story, input, run, runInput)
          ),
        }))
      })
    },
    []
  )
  const activityDetail = React.useCallback(
    (story: UserStory, activityId: string) =>
      api.activityDetail(story.id, activityId),
    [api]
  )
  const loadDetail = React.useCallback(
    async (story: UserStory) => {
      const existingRequest = detailRequests.current.get(story.id)
      if (existingRequest) {
        return existingRequest.then((loadedStory) =>
          mergeUserStory(story, loadedStory)
        )
      }
      const request = api
        .get(story.id)
        .then((loadedStory) => {
          setState((current) => ({
            ...current,
            detailedStoryIds: storyStateIds(
              current.detailedStoryIds,
              loadedStory.id,
              true
            ),
            stories: current.stories.map((currentStory) =>
              currentStory.id === loadedStory.id
                ? mergeUserStory(currentStory, loadedStory)
                : currentStory
            ),
          }))
          return loadedStory
        })
        .finally(() => {
          detailRequests.current.delete(story.id)
        })
      detailRequests.current.set(story.id, request)
      return request.then((loadedStory) => mergeUserStory(story, loadedStory))
    },
    [api]
  )
  const updateLocal = React.useCallback(
    (story: UserStory, input: UserStoryUpdate) => {
      recordPerformanceCount("backlog.store.update_local")
      setState((current) => ({
        ...current,
        stories: current.stories.map((currentStory) =>
          currentStory.id === story.id
            ? { ...currentStory, ...definedUpdate(input) }
            : currentStory
        ),
      }))
    },
    []
  )

  const remove = React.useCallback(
    async (story: UserStory) => {
      await api.delete(story.id)
      // The account deleted its copies; drop the screenshots on this device.
      void platform.agentScreenshots
        ?.delete({ scope: storyPreviewDevtoolsScope(story.id) })
        .catch(() => undefined)
      setState((current) => ({
        ...current,
        detailedStoryIds: storyStateIds(
          current.detailedStoryIds,
          story.id,
          false
        ),
        stories: current.stories.filter(
          (currentStory) => currentStory.id !== story.id
        ),
      }))
    },
    [api]
  )

  const storiesForColumn = React.useCallback(
    (column: BacklogColumnId) =>
      state.stories.filter((story) => story.status === column),
    [state.stories]
  )
  const setStorySetupInitializing = React.useCallback(
    (story: UserStory, initializing: boolean) => {
      setState((current) => ({
        ...current,
        setupInitializingStoryIds: setupInitializingStoryIds(
          current.setupInitializingStoryIds,
          story.id,
          initializing
        ),
      }))
    },
    []
  )
  const storySetupInitializing = React.useCallback(
    (story?: UserStory) =>
      Boolean(story && state.setupInitializingStoryIds.has(story.id)),
    [state.setupInitializingStoryIds]
  )
  const setStoryCleanup = React.useCallback(
    (story: UserStory, cleanup: boolean) => {
      setState((current) => ({
        ...current,
        cleanupStoryIds: storyStateIds(
          current.cleanupStoryIds,
          story.id,
          cleanup
        ),
      }))
    },
    []
  )
  const storyCleanup = React.useCallback(
    (story?: UserStory) =>
      Boolean(story && state.cleanupStoryIds.has(story.id)),
    [state.cleanupStoryIds]
  )

  return {
    ...state,
    create,
    createAgentRun,
    createComment,
    activityDetail,
    loadDetail,
    load,
    finalizeAgentRun,
    projectId,
    projectPath,
    remove,
    setStoryCleanup,
    setStorySetupInitializing,
    storyCleanup,
    storyDetailsLoaded: (story?: Pick<UserStory, "id">) =>
      Boolean(story && state.detailedStoryIds?.has(story.id)),
    storySetupInitializing,
    storiesForColumn,
    undoComment,
    validateCommentUndo,
    update,
    updateAgentLocal,
    updateAgentRun,
    updateLocal,
  }
}

function agentRunWithUpdate(
  run: UserStoryAgentRun,
  input: UserStoryAgentRunUpdate
) {
  const { agentActivity, agentActivityUpdates, ...metadata } = input
  const nextRun = {
    ...run,
    ...definedUpdate(metadata),
    updatedAt: new Date().toISOString(),
  }
  const activities = agentActivityUpdates ?? activityUpdateList(agentActivity)
  if (!activities.length) return nextRun
  return {
    ...nextRun,
    activities: nextAgentActivities(nextRun.activities ?? [], activities),
  }
}

function nextAgentActivities(
  activities: UserStoryAgentRun["activities"],
  updates: UserStoryAgentActivity[]
) {
  const currentActivities = activities ?? []
  return updates.reduce(upsertAgentActivity, currentActivities)
}

function activityUpdateList(
  activity: UserStoryAgentRunUpdate["agentActivity"]
) {
  return activity ? [activity] : []
}

function upsertAgentActivity(
  activities: UserStoryAgentActivity[],
  activity: UserStoryAgentActivity
) {
  const exists = activities.some((item) => item.id === activity.id)
  if (!exists) return [...activities, activity]
  return activities.map((item) => (item.id === activity.id ? activity : item))
}

function storyWithComment(story: UserStory, comment: UserStoryComment) {
  return {
    ...story,
    comments: [...(story.comments ?? []), comment],
  }
}

function storyWithActiveAgentRun(story: UserStory, run: UserStoryAgentRun) {
  const nextStory = mergeStoryAgentRun(story, run)
  if (run.status !== "running") return nextStory
  return {
    ...nextStory,
    activeAgentRunId: run.id,
    agentActivities: [],
    agentFinalResponse: null,
    agentStatus: "Running" as const,
    agentUsage: null,
    clineSessionId: run.clineSessionId,
    status: "in-progress" as const,
  }
}

async function enqueueStoryRequest<T>(
  queues: React.MutableRefObject<Map<string, Promise<unknown>>>,
  storyId: string,
  request: () => Promise<T>
) {
  const previous = queues.current.get(storyId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(request)
  queues.current.set(storyId, next)
  try {
    return await next
  } finally {
    if (queues.current.get(storyId) === next) queues.current.delete(storyId)
  }
}

function storyWithLocalAgentUpdate(
  currentStory: UserStory,
  targetStory: UserStory,
  input: UserStoryUpdate,
  run?: UserStoryAgentRun,
  runInput?: UserStoryAgentRunUpdate
) {
  if (currentStory.id !== targetStory.id) return currentStory
  const nextStory = { ...currentStory, ...definedUpdate(input) }
  if (!run || !runInput) return nextStory
  const currentRun =
    nextStory.agentRuns?.find((currentRun) => currentRun.id === run.id) ?? run
  return mergeStoryAgentRun(nextStory, agentRunWithUpdate(currentRun, runInput))
}

function definedUpdate(input: UserStoryUpdate | UserStoryAgentRunUpdate) {
  const { agentActivity, ...update } = input
  void agentActivity
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined)
  )
}

function setupInitializingStoryIds(
  current: Set<string>,
  storyId: string,
  initializing: boolean
) {
  return storyStateIds(current, storyId, initializing)
}

function storyStateIds(
  current: Set<string> | undefined,
  storyId: string,
  active: boolean
) {
  const next = new Set(current)
  if (active) next.add(storyId)
  else next.delete(storyId)
  return next
}

function replaceStory(
  story: UserStory,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  setState((current) => ({
    ...current,
    detailedStoryIds: storyStateIds(current.detailedStoryIds, story.id, true),
    stories: current.stories.map((currentStory) =>
      currentStory.id === story.id ? story : currentStory
    ),
  }))
}

function runCreatedStoryAttachmentUpload(
  story: UserStory,
  completeUpload: () => Promise<UserStory>,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  void completeUpload()
    .then((uploadedStory) =>
      setAttachmentUploadCompleted(story, uploadedStory, setState)
    )
    .catch((error) => {
      const message =
        error instanceof Error ? error.message : "Unknown upload error"
      setAttachmentUploadFailed(story.id, message, setState)
      toast.error("Attachment upload failed", {
        action: {
          label: "Retry",
          onClick: () => {
            setAttachmentUploading(story.id, setState)
            runCreatedStoryAttachmentUpload(story, completeUpload, setState)
          },
        },
        description: "The agent keeps the local copy. Retry to persist it.",
      })
    })
}

function setAttachmentUploadCompleted(
  sourceStory: UserStory,
  uploadedStory: UserStory,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  setState((current) => ({
    ...current,
    stories: current.stories.map((story) =>
      story.id === sourceStory.id
        ? {
            ...story,
            fileAttachments: sourceStory.fileAttachments,
            fileAttachmentUploadError: undefined,
            fileAttachmentUploadPending:
              uploadedStory.fileAttachmentUploadPending,
            fileAttachmentUploadStatus: undefined,
          }
        : story
    ),
  }))
}

function setAttachmentUploading(
  storyId: string,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  updateAttachmentUploadState(
    storyId,
    {
      fileAttachmentUploadError: undefined,
      fileAttachmentUploadStatus: "uploading",
    },
    setState
  )
}

function setAttachmentUploadFailed(
  storyId: string,
  message: string,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  updateAttachmentUploadState(
    storyId,
    {
      fileAttachmentUploadError: message,
      fileAttachmentUploadStatus: "failed",
    },
    setState
  )
}

function updateAttachmentUploadState(
  storyId: string,
  update: Partial<UserStory>,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  setState((current) => ({
    ...current,
    stories: current.stories.map((story) =>
      story.id === storyId ? { ...story, ...update } : story
    ),
  }))
}

function loadingState(current: BacklogState, projectId: string): BacklogState {
  if (current.projectId === projectId) {
    return {
      ...current,
      detailedStoryIds: current.detailedStoryIds ?? new Set(),
      error: undefined,
      loading: true,
    }
  }
  return {
    cleanupStoryIds: new Set(),
    detailedStoryIds: new Set(),
    loading: true,
    projectId,
    setupInitializingStoryIds: new Set(),
    stories: [],
  }
}
