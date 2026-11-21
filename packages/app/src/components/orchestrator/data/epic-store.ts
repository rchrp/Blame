import * as React from "react"
import type { EpicState } from "@blame/agent-runtime/engine-protocol"

import { createEpicApi } from "@/components/orchestrator/data/epic-api"
import type {
  Epic,
  EpicDraft,
  EpicUpdate,
} from "@/components/orchestrator/data/epic-data"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { readUiMemory, writeUiMemory } from "@/lib/ui-memory"

type StoreState = {
  // The epic the orchestrator page shows; none shows the new epic form.
  activeId?: string
  epics: Epic[]
  error?: string
  loading: boolean
  projectId?: string
}

type EpicStoreValue = ReturnType<typeof useEpicStoreValue>

const EpicStoreContext = React.createContext<EpicStoreValue | undefined>(
  undefined
)

// The page's choice, per project, survives a restart.
const activeEpicMemoryKey = "orchestrator.active-epic"

export function EpicStoreProvider({ children }: { children: React.ReactNode }) {
  const value = useEpicStoreValue()
  return React.createElement(EpicStoreContext.Provider, { value }, children)
}

export function useEpicStore() {
  const context = React.useContext(EpicStoreContext)
  if (!context)
    throw new Error("useEpicStore must be used within EpicStoreProvider")
  return context
}

// The project's epics, read and written through the API. Their stories are
// the backlog store's, filtered by `epicId`.
function useEpicStoreValue() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const projectId = projects.activeProject?.id
  const [state, setState] = React.useState<StoreState>({
    epics: [],
    loading: false,
  })
  const api = React.useMemo(
    () => createEpicApi(auth.apiConnection),
    [auth.apiConnection]
  )
  const loadRequestId = React.useRef(0)

  const load = React.useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (!projectId) {
      setState({ epics: [], loading: false })
      return
    }
    setState((current) => ({
      ...current,
      epics: current.projectId === projectId ? current.epics : [],
      loading: true,
      projectId,
    }))
    try {
      const epics = await api.list(projectId)
      if (loadRequestId.current !== requestId) return
      setState((current) => ({
        activeId: activeEpicId(
          current.projectId === projectId && current.activeId
            ? current.activeId
            : rememberedEpicId(projectId),
          epics
        ),
        epics,
        loading: false,
        projectId,
      }))
    } catch (error) {
      if (loadRequestId.current !== requestId) return
      setState({
        epics: [],
        error:
          error instanceof Error ? error.message : "Unable to load the epics.",
        loading: false,
        projectId,
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

  // What the engine host says of each epic: its conversation and spend.
  const [states, setStates] = React.useState<ReadonlyMap<string, EpicState>>(
    () => new Map()
  )
  const putState = React.useCallback((state: EpicState) => {
    setStates((current) => new Map(current).set(state.epicId, state))
  }, [])
  React.useEffect(
    () => platform.engine?.onEpic?.((event) => putState(event.state)),
    [platform.engine, putState]
  )
  const epicIds = state.epics.map((epic) => epic.id).join(",")
  React.useEffect(() => {
    const engine = platform.engine
    if (!engine || !epicIds) return
    let cancelled = false
    for (const epicId of epicIds.split(","))
      void engine
        .call("epicState", { epicId })
        .then((next) => {
          if (!cancelled) putState(next)
        })
        .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [epicIds, platform.engine, putState])

  /** Tells the host an epic changed (settings, a pause) and takes its state. */
  const changed = React.useCallback(
    async (epicId: string) => {
      const next = await platform.engine?.call("epicChanged", { epicId })
      if (next) putState(next)
    },
    [platform.engine, putState]
  )

  const replace = React.useCallback((epic: Epic) => {
    setState((current) => ({
      ...current,
      epics: current.epics.some((item) => item.id === epic.id)
        ? current.epics.map((item) => (item.id === epic.id ? epic : item))
        : [epic, ...current.epics],
    }))
  }, [])

  const create = React.useCallback(
    async (input: Omit<EpicDraft, "projectId">) => {
      if (!projectId) throw new Error("Open a project first.")
      const epic = await api.create({ ...input, projectId })
      replace(epic)
      return epic
    },
    [api, projectId, replace]
  )

  const update = React.useCallback(
    async (epic: Epic, input: EpicUpdate) => {
      const next = await api.update(epic.id, input)
      replace(next)
      // The host reads the epic again: a pause holds its stories, new
      // settings apply from the orchestrator's next call.
      if (input.status !== undefined || input.settings !== undefined)
        await changed(epic.id).catch(() => undefined)
      return next
    },
    [api, changed, replace]
  )

  /** Reads an epic again (the host writes its branch and session). */
  const reload = React.useCallback(
    async (epicId: string) => {
      const next = await api.get(epicId)
      replace(next)
      return next
    },
    [api, replace]
  )

  const setActiveId = React.useCallback(
    (activeId: string | undefined) => {
      if (projectId) writeUiMemory(memoryKey(projectId), activeId ?? null)
      setState((current) => ({ ...current, activeId }))
    },
    [projectId]
  )

  const epics = React.useMemo(
    () => [...state.epics].sort(compareEpicsByMostRecent),
    [state.epics]
  )

  return {
    ...state,
    activeEpic: state.epics.find((epic) => epic.id === state.activeId),
    create,
    epics,
    load,
    projectId,
    putState,
    reload,
    setActiveId,
    states,
    update,
  }
}

function memoryKey(projectId: string) {
  return `${activeEpicMemoryKey}.${projectId}`
}

function rememberedEpicId(projectId: string) {
  return readUiMemory(memoryKey(projectId), isEpicId)
}

function isEpicId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

// The remembered epic while it exists, else the latest one still going.
function activeEpicId(remembered: string | undefined, epics: Epic[]) {
  if (remembered && epics.some((epic) => epic.id === remembered))
    return remembered
  return [...epics]
    .sort(compareEpicsByMostRecent)
    .find((epic) => epic.status === "active" || epic.status === "paused")?.id
}

function compareEpicsByMostRecent(left: Epic, right: Epic) {
  return epicTimestamp(right) - epicTimestamp(left)
}

function epicTimestamp(epic: Epic) {
  return new Date(epic.updatedAt ?? epic.createdAt).getTime() || 0
}
