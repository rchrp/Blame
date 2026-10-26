import * as React from "react"
import type { AgentConversationRun } from "../agent-conversation"
import type { UserStoryAgentActivity } from "@/components/backlog/data/backlog-data"
import {
  collectResearchSources,
  type ResearchSource,
} from "./web-research-data"

const Context = React.createContext<{
  sources: ResearchSource[]
  loading: boolean
  details: Map<string, string>
  rememberDetail: (id: string, detail: string) => void
}>({
  sources: [],
  loading: false,
  details: new Map(),
  rememberDetail: () => {},
})

export function WebResearchProvider({
  runs,
  loadDetail,
  children,
}: {
  runs: AgentConversationRun[]
  loadDetail: (
    run: AgentConversationRun,
    activity: UserStoryAgentActivity
  ) => Promise<string>
  children: React.ReactNode
}) {
  const [details, setDetails] = React.useState(new Map<string, string>())
  const pending = runs.flatMap((run) =>
    (run.activities ?? []).flatMap((activity) =>
      activity.kind === "tool" &&
      /search_web|read_web_page/.test(activity.toolName ?? activity.detail) &&
      activity.detailTruncated &&
      !details.has(activity.id)
        ? [{ run, activity }]
        : []
    )
  )
  const pendingKey = pending
    .map(
      ({ run, activity }) =>
        `${run.id}:${activity.id}:${activity.detailArtifact ?? ""}`
    )
    .join("|")
  const hydrate = React.useEffectEvent(async (cancelled: () => boolean) => {
    const queue = [...pending]
    const next = new Map<string, string>()
    async function worker() {
      for (
        let item = queue.shift();
        item && !cancelled();
        item = queue.shift()
      ) {
        try {
          next.set(item.activity.id, await loadDetail(item.run, item.activity))
        } catch {
          next.set(item.activity.id, item.activity.detail)
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return next
  })
  React.useEffect(() => {
    if (!pendingKey) return
    let cancelled = false
    void hydrate(() => cancelled).then((next) => {
      if (!cancelled) setDetails((previous) => new Map([...previous, ...next]))
    })
    return () => {
      cancelled = true
    }
  }, [pendingKey])
  const rememberDetail = React.useCallback((id: string, detail: string) => {
    setDetails((previous) => new Map(previous).set(id, detail))
  }, [])

  const sources = React.useMemo(
    () =>
      collectResearchSources(
        runs.flatMap((run) =>
          (run.activities ?? []).map((activity) => ({
            runId: run.id,
            kind: activity.kind,
            detail: details.get(activity.id) ?? activity.detail,
          }))
        ),
        runs.flatMap((run) => [
          run.finalResponse ?? "",
          ...(run.activities ?? [])
            .filter((activity) => activity.kind === "message")
            .map((activity) => activity.detail),
        ])
      ),
    [runs, details]
  )
  return (
    <Context.Provider
      value={{ sources, loading: pending.length > 0, details, rememberDetail }}
    >
      {children}
    </Context.Provider>
  )
}

export function useWebResearch() {
  return React.useContext(Context)
}
