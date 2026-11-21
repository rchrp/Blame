import * as React from "react"
import { saveStoryContextLimit } from "./story-context-limit"
import { toast } from "sonner"

import {
  createBacklogApi,
  parseUserStory,
} from "@/components/backlog/data/backlog-api"
import {
  mergeLoadedStories,
  mergeUserStory,
} from "@/components/backlog/data/backlog-store-merge"
import type {
  BacklogColumnId,
  UserStory,
  UserStoryDraft,
  UserStoryUpdate,
} from "@/components/backlog/data/backlog-data"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { storyPreviewDevtoolsScope } from "@/components/backlog/shared/preview-devtools-scope"
import { useProjects } from "@/context/projects"
import { recordPerformanceCount } from "@/lib/performance-diagnostics"
import { refreshStoryService } from "@/lib/story-service"

type BacklogState = {
  cleanupStoryIds: Set<string>
  detailedStoryIds: Set<string>
  error?: string
  loading: boolean
  projectId?: string
  setupInitializingStoryIds: Set<string>
  stories: UserStory[]
}

type BacklogActions = ReturnType<typeof useBacklogActions>
type BacklogStoreValue = ReturnType<typeof backlogValue>

// The backlog's state lives outside React so that a component can follow
// only the part it shows: an agent saving its run re-renders what shows
// that run, not every reader of the backlog.
type BacklogStateStore = {
  get(): BacklogState
  set: React.Dispatch<React.SetStateAction<BacklogState>>
  subscribe(listener: () => void): () => void
}

const BacklogStoreContext = React.createContext<
  { actions: BacklogActions; state: BacklogStateStore } | undefined
>(undefined)

export function BacklogStoreProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [state] = React.useState(createBacklogStateStore)
  const actions = useBacklogActions(state.set)
  const value = React.useMemo(() => ({ actions, state }), [actions, state])

  return React.createElement(BacklogStoreContext.Provider, { value }, children)
}

// The whole backlog: re-renders on every change.
export function useBacklogStore() {
  const { actions, state } = useBacklogContext()
  const snapshot = React.useSyncExternalStore(state.subscribe, state.get)
  return backlogValue(snapshot, actions)
}

// What `select` reads from the backlog: re-renders only when that changes,
// as `equal` compares it.
export function useBacklogSelector<T>(
  select: (backlog: BacklogStoreValue) => T,
  equal: (left: T, right: T) => boolean = Object.is
) {
  const { actions, state } = useBacklogContext()
  const selection = React.useRef<{
    actions: BacklogActions
    select: typeof select
    snapshot: BacklogState
    value: T
  }>(undefined)
  const selected = () => {
    const snapshot = state.get()
    const current = selection.current
    if (
      current?.snapshot === snapshot &&
      current.actions === actions &&
      current.select === select
    )
      return current.value
    const value = select(backlogValue(snapshot, actions))
    selection.current = {
      actions,
      select,
      snapshot,
      value: current && equal(current.value, value) ? current.value : value,
    }
    return selection.current.value
  }
  return React.useSyncExternalStore(state.subscribe, selected)
}

function useBacklogContext() {
  const context = React.useContext(BacklogStoreContext)
  if (!context)
    throw new Error("useBacklogStore must be used within BacklogStoreProvider")
  return context
}

function createBacklogStateStore(): BacklogStateStore {
  let state: BacklogState = {
    cleanupStoryIds: new Set(),
    detailedStoryIds: new Set(),
    loading: false,
    setupInitializingStoryIds: new Set(),
    stories: [],
  }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(update) {
      const next = typeof update === "function" ? update(state) : update
      if (next === state) return
      state = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function backlogValue(state: BacklogState, actions: BacklogActions) {
  return { ...state, ...actions, ...backlogReaders(state) }
}

// Each reader keeps its identity while what it reads is unchanged, so that
// a component given one re-renders only when that changed.
const readers = new WeakMap<object, unknown>()

function backlogReaders(state: BacklogState) {
  return {
    storiesForColumn: reader(
      state.stories,
      () => (column: BacklogColumnId) =>
        state.stories.filter((story) => story.status === column)
    ),
    storyCleanup: reader(state.cleanupStoryIds, () =>
      storyIn(state.cleanupStoryIds)
    ),
    storyDetailsLoaded: reader(state.detailedStoryIds, () =>
      storyIn(state.detailedStoryIds)
    ),
    storySetupInitializing: reader(state.setupInitializingStoryIds, () =>
      storyIn(state.setupInitializingStoryIds)
    ),
  }
}

function reader<Reader>(source: object, create: () => Reader) {
  if (!readers.has(source)) readers.set(source, create())
  return readers.get(source) as Reader
}

function storyIn(storyIds: Set<string>) {
  return (story?: Pick<UserStory, "id">) =>
    Boolean(story && storyIds.has(story.id))
}

function useBacklogActions(
  setState: React.Dispatch<React.SetStateAction<BacklogState>>
) {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const loadRequestId = React.useRef(0)
  const detailRequests = React.useRef(new Map<string, Promise<UserStory>>())
  const updateQueues = React.useRef(new Map<string, Promise<unknown>>())
  const projectId = projects.activeProject?.id
  const projectPath = projects.activeProject?.path

  const api = React.useMemo(
    () => createBacklogApi(auth.apiConnection),
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
  }, [api, projectId, setState])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      loadRequestId.current += 1
    }
  }, [load])

  // The story service in the engine host writes the stories' agent state:
  // what it wrote shows here as it happens.
  React.useEffect(
    () =>
      platform.engine?.onStory((event) => {
        if (event.type === "story-queue" || event.projectId !== projectId)
          return
        if (event.type === "story-removed") {
          setState((current) => ({
            ...current,
            stories: current.stories.filter(({ id }) => id !== event.storyId),
          }))
          return
        }
        let story: UserStory
        try {
          story = parseUserStory(event.story)
        } catch {
          return
        }
        setState((current) => ({
          ...current,
          stories: current.stories.some(({ id }) => id === story.id)
            ? current.stories.map((currentStory) =>
                currentStory.id === story.id
                  ? mergeUserStory(currentStory, story)
                  : currentStory
              )
            : [...current.stories, story],
        }))
      }),
    [platform.engine, projectId, setState]
  )

  const create = React.useCallback(
    async (input: Omit<UserStoryDraft, "projectId">, contextLimit?: number) => {
      if (!projectId)
        throw new Error("Open a project before creating a user story.")
      const creation = await api.create({ ...input, projectId })
      const story = creation.story
      // Publish the budget before the ready queue can start this story.
      if (contextLimit) saveStoryContextLimit(story.id, contextLimit)
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
          setState,
          // Its files uploaded: a queued story can start.
          () => void refreshStoryService(platform.engine, projectId)
        )
      }
      // A story created in the queue starts now.
      void refreshStoryService(platform.engine, projectId).catch(
        () => undefined
      )
      return story
    },
    [api, platform.engine, projectId, setState]
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
              ? mergeUserStory(currentStory, nextStory)
              : currentStory
          ),
        }))
        return nextStory
      }),
    [api, setState]
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
    [api, setState]
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
    [setState]
  )

  const remove = React.useCallback(
    async (story: UserStory) => {
      await api.delete(story.id)
      // The account deleted its copies; drop the screenshots on this device:
      // its preview's, and those its conversation took elsewhere (a component
      // preview, a project folder) unless another conversation took them too.
      void platform.agentScreenshots
        ?.delete({
          scope: storyPreviewDevtoolsScope(story.id),
          ...(story.engineSessionId
            ? { sessionIds: [story.engineSessionId] }
            : {}),
        })
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
    [api, platform.agentScreenshots, setState]
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
    [setState]
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
    [setState]
  )
  return React.useMemo(
    () => ({
      create,
      load,
      loadDetail,
      projectId,
      projectPath,
      remove,
      setStoryCleanup,
      setStorySetupInitializing,
      update,
      updateLocal,
    }),
    [
      create,
      load,
      loadDetail,
      projectId,
      projectPath,
      remove,
      setStoryCleanup,
      setStorySetupInitializing,
      update,
      updateLocal,
    ]
  )
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

function definedUpdate(input: UserStoryUpdate) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
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

function runCreatedStoryAttachmentUpload(
  story: UserStory,
  completeUpload: () => Promise<UserStory>,
  setState: React.Dispatch<React.SetStateAction<BacklogState>>,
  onUploaded: () => void
) {
  void completeUpload()
    .then((uploadedStory) => {
      setAttachmentUploadCompleted(story, uploadedStory, setState)
      onUploaded()
    })
    .catch((error) => {
      const message =
        error instanceof Error ? error.message : "Unknown upload error"
      setAttachmentUploadFailed(story.id, message, setState)
      toast.error("Attachment upload failed", {
        action: {
          label: "Retry",
          onClick: () => {
            setAttachmentUploading(story.id, setState)
            runCreatedStoryAttachmentUpload(
              story,
              completeUpload,
              setState,
              onUploaded
            )
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
