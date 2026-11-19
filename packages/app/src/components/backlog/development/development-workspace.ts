import * as React from "react"
import { storyWorkingDiff } from "./story-working-diff.ts"

import type { UserStory } from "@/components/backlog/data/backlog-data"
import {
  isIgnoredDiffPath,
  parseGitDiff,
  type ParsedVcsFileDiff,
} from "@/components/backlog/development/development-diff-parser"
import { usePlatform } from "@/context/platform"
import { useProjects } from "@/context/projects"

export { parseGitDiff } from "@/components/backlog/development/development-diff-parser"

export type DevelopmentDiffKind = "add" | "del" | "mix"
export type DevelopmentFileTab = {
  path: string
}
export type FileNode = {
  absolute?: string
  ignored?: boolean
  name: string
  path: string
  type: "directory" | "file"
}
export type FileContent = {
  content: string
  diff?: string
  encoding?: string
  mimeType?: string
  type?: string
}
export type VcsFileDiff = ParsedVcsFileDiff

export function useDevelopmentWorkspace(
  userStory?: UserStory,
  fallbackToProjectRoot?: boolean,
  refreshEnabled = true
) {
  const platform = usePlatform()
  const projects = useProjects()
  const [reloadKey, setReloadKey] = React.useState(0)
  const historicalRefs = React.useMemo(
    () => storyHistoricalRefs(userStory),
    [userStory]
  )
  const historical = !userStory?.worktree && Boolean(historicalRefs)
  const directory =
    userStory?.worktree ??
    (historical || fallbackToProjectRoot
      ? projects.activeProject?.path
      : undefined)

  const listDirectory = React.useCallback(
    async (path: string) => {
      if (!directory || !platform.workspace) return []
      if (historicalRefs) {
        return normalizeNodes(
          await platform.workspace.listGitDirectory({
            path,
            refs: historicalRefs,
            root: directory,
          })
        )
      }
      const nodes = await platform.workspace.listDirectory({
        root: directory,
        path,
      })
      return normalizeNodes(nodes)
    },
    [directory, historicalRefs, platform.workspace]
  )

  const searchFiles = React.useCallback(
    async (query: string) => {
      if (!directory || !platform.workspace || historicalRefs) return undefined
      return normalizeNodes(
        await platform.workspace.searchFiles({
          limit: 100,
          query,
          root: directory,
        })
      )
    },
    [directory, historicalRefs, platform.workspace]
  )

  const readFile = React.useCallback(
    async (path: string) => {
      if (!directory || !platform.workspace) return undefined
      if (historicalRefs) {
        return {
          content: await platform.workspace.readGitFile({
            path,
            refs: historicalRefs,
            root: directory,
          }),
        }
      }
      return {
        content: await platform.workspace.readFile({ root: directory, path }),
      }
    },
    [directory, historicalRefs, platform.workspace]
  )

  // Polled: the same diff keeps its parsed files, so nothing renders again.
  const parsedDiff = React.useRef<{ diffs: VcsFileDiff[]; source: string }>(
    undefined
  )
  const loadDiffs = React.useCallback(async () => {
    if (!directory || !platform.workspace) return []
    const diff = historicalRefs
      ? await platform.workspace.gitDiffBetween({
          from: historicalRefs[1],
          root: directory,
          to: historicalRefs[0],
        })
      : await storyWorkingDiff(
          {
            root: directory,
            baseCommit: userStory?.baseCommit,
            repositoryRoot: projects.activeProject?.path,
          },
          platform.workspace
        )
    if (parsedDiff.current?.source === diff) return parsedDiff.current.diffs
    const diffs = normalizeDiffs(parseGitDiff(diff))
    parsedDiff.current = { diffs, source: diff }
    return diffs
  }, [
    directory,
    historicalRefs,
    platform.workspace,
    userStory?.baseCommit,
    projects.activeProject?.path,
  ])

  React.useEffect(() => {
    if (!directory || historical || !refreshEnabled) return
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      setReloadKey((current) => current + 1)
    }, 1_500)
    return () => clearInterval(timer)
  }, [directory, historical, refreshEnabled])

  return {
    available: Boolean(directory && platform.workspace),
    hasServer: Boolean(platform.workspace),
    root: directory,
    listDirectory,
    searchFiles,
    readFile,
    loadDiffs,
    reloadKey,
  }
}

function storyHistoricalRefs(
  userStory?: UserStory
): [string, string] | undefined {
  if (userStory?.status !== "done" || !userStory.mergeCommit) return undefined
  return [
    userStory.mergeCommit,
    userStory.baseCommit ?? `${userStory.mergeCommit}^`,
  ]
}

export function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

export function filename(path: string) {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

export function buildDiffKinds(diffs: VcsFileDiff[]) {
  const merge = (
    current: DevelopmentDiffKind | undefined,
    next: DevelopmentDiffKind
  ) => {
    if (!current) return next
    if (current === next) return current
    return "mix" as const
  }

  return diffs.reduce((items, diff) => {
    const path = normalizePath(diff.file)
    const kind =
      diff.status === "added"
        ? "add"
        : diff.status === "deleted"
          ? "del"
          : "mix"
    items.set(path, kind)
    parents(path).forEach((parent) =>
      items.set(parent, merge(items.get(parent), kind))
    )
    return items
  }, new Map<string, DevelopmentDiffKind>())
}

export function diffKindLabel(kind: DevelopmentDiffKind) {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

export function diffKindClassName(kind: DevelopmentDiffKind) {
  if (kind === "add")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (kind === "del")
    return "border-destructive/30 bg-destructive/10 text-destructive"
  return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
}

export function normalizeNodes(nodes: FileNode[]) {
  return nodes
    .map((node) => ({ ...node, path: normalizePath(node.path) }))
    .sort(sortNodes)
}

export function normalizeDiffs(diffs: VcsFileDiff[]) {
  return diffs
    .filter((diff) => !isIgnoredDiffPath(diff.file))
    .map((diff) => ({ ...diff, file: normalizePath(diff.file) }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

function sortNodes(a: FileNode, b: FileNode) {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  return a.name.localeCompare(b.name)
}

function parents(path: string) {
  return path
    .split("/")
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
    .filter(Boolean)
}

export type DevelopmentFileContent = FileContent | undefined
