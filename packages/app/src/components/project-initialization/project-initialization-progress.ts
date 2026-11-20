import * as React from "react"
import type { SessionRecord } from "@blame/engine-client"

// Live progress of the initialization this app runs, by project: the toast
// and the Initialization page show the same steps. They come from the
// records of the analysis's engine task: the tools the agent calls, and the
// submissions Blame checks and sends back.

export type ProjectInitializationProgress = {
  percent: number
  label: string
  detail?: string
  /** The person cancelled the run: it is stopping. */
  cancelling?: boolean
  startedAt: number
}

const progressByProject = new Map<string, ProjectInitializationProgress>()
const listeners = new Set<() => void>()

export type InitializationProgressUpdate = {
  percent: number
  label: string
  detail?: string
}

const submitTool = "submit_project_initialization"

/**
 * Reads an analysis's records, in order, into the steps the bar shows: it
 * starts at 10% when the analysis starts and stays under 100% until the
 * setup is saved.
 */
export function initializationTaskProgress() {
  let percent = 10
  let correcting = false
  const submissions = new Set<string>()
  const update = (
    to: number,
    label: string,
    detail?: string
  ): InitializationProgressUpdate => {
    percent = Math.max(percent, Math.min(Math.round(to), 99))
    return { percent, label, ...(detail ? { detail } : {}) }
  }
  return (record: SessionRecord): InitializationProgressUpdate | undefined => {
    switch (record.type) {
      case "tool_call_started":
        if (record.name === submitTool) {
          submissions.add(record.call)
          return update(percent + (95 - percent) * 0.35, "Checking the setup")
        }
        return update(
          percent + (86 - percent) * 0.12,
          correcting ? "Fixing the setup" : initializationToolLabel(record.name)
        )
      case "tool_call_finished": {
        if (!submissions.has(record.call) || record.outcome !== "failed")
          return undefined
        correcting = true
        const text = record.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
        const count = /Submission (\d+) of (\d+) was rejected/.exec(text)
        const problem = /^1\. \[(?:must fix|warning)\] (.+)$/m.exec(text)
        return update(
          percent,
          count
            ? `Fixing the setup · ${Number(count[1]) + 1} of ${count[2]}`
            : "Fixing the setup",
          problem?.[1] ?? text.split("\n")[0]
        )
      }
      case "result_rejected":
        correcting = true
        return update(
          percent,
          "Fixing the setup",
          record.invalid?.[0] ??
            (record.unmet?.length ? "The project is read first." : undefined)
        )
      default:
        return undefined
    }
  }
}

export function initializationToolLabel(toolName: string) {
  const name = toolName.toLowerCase()
  if (/read/.test(name)) return "Reading project files"
  if (/search/.test(name)) return "Searching the code"
  return "Analyzing the project"
}

export function setInitializationProgress(
  projectId: string,
  progress: Omit<ProjectInitializationProgress, "startedAt"> | undefined
) {
  const current = progressByProject.get(projectId)
  if (!progress) progressByProject.delete(projectId)
  else
    progressByProject.set(projectId, {
      ...progress,
      // The bar never moves back, even when a later step reports less.
      percent: Math.max(progress.percent, current?.percent ?? 0),
      startedAt: current?.startedAt ?? Date.now(),
    })
  listeners.forEach((listener) => listener())
}

export function initializationProgressFor(projectId: string) {
  return progressByProject.get(projectId)
}

export function useInitializationProgress(projectId: string | undefined) {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => (projectId ? progressByProject.get(projectId) : undefined)
  )
}
