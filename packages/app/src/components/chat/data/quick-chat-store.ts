import * as React from "react"

import { createQuickChatApi } from "@/components/chat/data/quick-chat-api"
import type {
  QuickChat,
  QuickChatDraft,
  QuickChatUpdate,
} from "@/components/chat/data/quick-chat-data"
import { useCloudAuth } from "@/context/cloud-auth"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"
import { showSystemNotification } from "@/lib/system-notifications"

type QuickChatState = {
  activeId?: string
  chats: QuickChat[]
  error?: string
  loading: boolean
  projectId?: string
}

type QuickChatStoreValue = ReturnType<typeof useQuickChatStoreValue>

const QuickChatStoreContext = React.createContext<
  QuickChatStoreValue | undefined
>(undefined)

export function QuickChatStoreProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const value = useQuickChatStoreValue()
  return React.createElement(
    QuickChatStoreContext.Provider,
    { value },
    children
  )
}

export function useQuickChatStore() {
  const context = React.useContext(QuickChatStoreContext)
  if (!context)
    throw new Error(
      "useQuickChatStore must be used within QuickChatStoreProvider"
    )
  return context
}

// The project's quick chats (title, folder, engine session) and which of
// them has an agent working now. What each conversation says is read from
// its engine session when it is shown (useEngineSession).
function useQuickChatStoreValue() {
  const auth = useCloudAuth()
  const platform = usePlatform()
  const projects = useProjects()
  const [state, setState] = React.useState<QuickChatState>({
    chats: [],
    loading: false,
  })
  const running = useRunningSessions()
  const loadRequestId = React.useRef(0)
  const projectId = projects.activeProject?.id
  const api = React.useMemo(
    () => createQuickChatApi(auth.apiConnection),
    [auth.apiConnection]
  )
  const chatsRef = React.useRef(state.chats)
  chatsRef.current = state.chats

  const load = React.useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (!projectId) {
      setState({ chats: [], loading: false, projectId: undefined })
      return
    }
    setState((current) => ({
      ...current,
      chats: current.projectId === projectId ? current.chats : [],
      loading: true,
      projectId,
    }))
    try {
      const chats = await api.list(projectId)
      if (loadRequestId.current !== requestId) return
      setState((current) => ({
        activeId: activeQuickChatId(current.activeId, chats),
        chats,
        loading: false,
        projectId,
      }))
    } catch (error) {
      if (loadRequestId.current !== requestId) return
      setState({
        chats: [],
        error:
          error instanceof Error ? error.message : "Unable to load quick chats.",
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

  // A finished answer is worth a notification when the person looks away.
  React.useEffect(
    () =>
      platform.engine?.onActivity((event) => {
        if (event.running || event.outcome?.status !== "completed") return
        const chat = chatsRef.current.find(
          (item) => item.engineSessionId === event.session
        )
        if (!chat) return
        touch(chat.id)
        void showSystemNotification(platform, {
          body: chat.title,
          target: { pathname: "/chat", chatId: chat.id },
          title: "Agent response ready",
        })
      }),
    [platform]
  )

  function touch(chatId: string) {
    const now = new Date().toISOString()
    setState((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === chatId ? { ...chat, lastActivityAt: now } : chat
      ),
    }))
  }

  const create = React.useCallback(
    async (input: Omit<QuickChatDraft, "engineSessionId" | "projectId">) => {
      if (!projectId) throw new Error("Open a project first.")
      const chat = await api.create({
        ...input,
        // The chat names its engine session; the engine keeps that id.
        engineSessionId: crypto.randomUUID(),
        projectId,
      })
      // Opened by the caller once its engine session exists: following a
      // session the engine does not have yet would fail for good.
      setState((current) => ({
        ...current,
        chats: [chat, ...current.chats.filter((item) => item.id !== chat.id)],
      }))
      return chat
    },
    [api, projectId]
  )

  const update = React.useCallback(
    async (chat: QuickChat, input: QuickChatUpdate) => {
      const next = await api.update(chat.id, input)
      setState((current) => ({
        ...current,
        chats: current.chats.map((item) => (item.id === next.id ? next : item)),
      }))
      return next
    },
    [api]
  )

  const stopAgent = React.useCallback(
    async (chat: QuickChat) => {
      const session = chat.engineSessionId
      if (session && running.has(session))
        await platform.engine?.call("interrupt", { session })
    },
    [platform.engine, running]
  )

  const remove = React.useCallback(
    async (chat: QuickChat) => {
      await stopAgent(chat)
      // The API deletes the conversation's log with the chat.
      await api.delete(chat.id)
      setState((current) => ({
        ...current,
        activeId:
          current.activeId === chat.id
            ? current.chats.find((item) => item.id !== chat.id)?.id
            : current.activeId,
        chats: current.chats.filter((item) => item.id !== chat.id),
      }))
    },
    [api, stopAgent]
  )

  const setActiveId = React.useCallback((activeId: string | undefined) => {
    setState((current) => ({ ...current, activeId }))
  }, [])

  const clearActiveId = React.useCallback((chatId: string) => {
    setState((current) =>
      current.activeId === chatId ? { ...current, activeId: undefined } : current
    )
  }, [])

  const isRunning = React.useCallback(
    (chat: QuickChat | undefined) =>
      Boolean(chat?.engineSessionId && running.has(chat.engineSessionId)),
    [running]
  )

  return {
    ...state,
    activeChat: state.chats.find((chat) => chat.id === state.activeId),
    clearActiveId,
    create,
    isRunning,
    load,
    projectId,
    remove,
    runningCount: state.chats.filter(isRunning).length,
    setActiveId,
    stopAgent,
    touch,
    update,
  }
}

// The sessions whose agent works now, as the engine host reports them.
function useRunningSessions() {
  const platform = usePlatform()
  const [running, setRunning] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  React.useEffect(() => {
    const engine = platform.engine
    if (!engine) return
    let current = new Set<string>()
    const apply = (next: Set<string>) => {
      current = next
      setRunning(next)
    }
    const stop = engine.onActivity((event) => {
      const next = new Set(current)
      if (event.running) next.add(event.session)
      else next.delete(event.session)
      apply(next)
    })
    void engine
      .call("running", undefined)
      .then((sessions) => apply(new Set([...current, ...sessions])))
      .catch(() => undefined)
    return stop
  }, [platform.engine])
  return running
}

function activeQuickChatId(activeId: string | undefined, chats: QuickChat[]) {
  if (activeId && chats.some((chat) => chat.id === activeId)) return activeId
  return chats[0]?.id
}
