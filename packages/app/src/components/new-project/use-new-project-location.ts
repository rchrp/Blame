import * as React from "react"
import type { WorkspaceClient } from "@/context/platform"

export function newProjectPath(parentPath: string, projectName: string) {
  const parent = parentPath.trim()
  const name = projectName.trim()
  if (!parent || !name) return ""
  const separator = parent.includes("\\") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`
}

export function useNewProjectLocation(input: {
  enabled: boolean
  path: string
  pathExists: WorkspaceClient["pathExists"] | undefined
  ownedByCurrentAttempt: boolean
}) {
  const { enabled, path, pathExists, ownedByCurrentAttempt } = input
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  const request = React.useMemo(
    () => ({ enabled, path, pathExists, ownedByCurrentAttempt, revision }),
    [enabled, path, pathExists, ownedByCurrentAttempt, revision]
  )
  const [result, setResult] = React.useState<{
    request: typeof request
    error?: string
  }>()

  React.useEffect(() => {
    if (!enabled) return
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [enabled])

  React.useEffect(() => {
    if (!request.enabled || !request.path || !request.pathExists) return
    let cancelled = false
    const timeout = window.setTimeout(async () => {
      try {
        const exists = await request.pathExists!({ path: request.path })
        if (!cancelled) {
          setResult({
            request,
            error:
              exists && !request.ownedByCurrentAttempt
                ? "A file or folder already exists here. Choose another name or location."
                : undefined,
          })
        }
      } catch {
        if (!cancelled) {
          setResult({
            request,
            error:
              "Unable to check this folder. Check the location and try again.",
          })
        }
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [request])

  const checked = result?.request === request
  return {
    checking: enabled && Boolean(path && pathExists) && !checked,
    error: enabled && checked ? result.error : undefined,
    available: enabled && checked && !result.error,
  }
}
