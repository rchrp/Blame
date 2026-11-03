import * as React from "react"
import type { FileNode } from "@/components/backlog/development/development-workspace"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { DevelopmentFileIcon } from "@/components/backlog/development/development-file-icon"
import {
  searchDevelopmentFiles,
  type DevelopmentFileSearchItem,
} from "@/components/backlog/development/development-file-search"
import {
  diffKindLabel,
  filename,
  normalizePath,
  type DevelopmentDiffKind,
} from "@/components/backlog/development/development-workspace"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const maxDepth = 128

type DirectoryState = {
  loading: boolean
  nodes: FileNode[]
  error?: string
}

export function DevelopmentFileTree({
  active,
  allowed,
  className,
  kinds,
  listDirectory,
  modified,
  onFileClick,
  query: controlledQuery,
  reloadKey,
  searchFiles,
}: {
  active?: string
  allowed?: string[]
  className?: string
  kinds?: Map<string, DevelopmentDiffKind>
  listDirectory: (path: string) => Promise<FileNode[]>
  modified?: string[]
  onFileClick: (path: string) => void
  // Searched from a field of its own above the tree (the Code tab's
  // toolbar); the tree shows its own field otherwise.
  query?: string
  reloadKey?: number
  searchFiles?: (query: string) => Promise<FileNode[] | undefined>
}) {
  const [expanded, setExpanded] = React.useState(() => new Set([""]))
  const [directories, setDirectories] = React.useState<
    Record<string, DirectoryState>
  >({})
  const [ownQuery, setQuery] = React.useState("")
  const query = controlledQuery ?? ownQuery
  const [remoteSearchMatches, setRemoteSearchMatches] = React.useState<
    string[] | null
  >(null)
  const [searchLoading, setSearchLoading] = React.useState(false)
  const refreshedKeyRef = React.useRef(reloadKey)
  const searchRequestRef = React.useRef(0)
  const normalizedAllowed = React.useMemo(
    () => allowed?.map(normalizePath).filter(Boolean),
    [allowed]
  )
  const modifiedSet = React.useMemo(
    () => new Set(modified?.map(normalizePath) ?? []),
    [modified]
  )
  const searchItems = React.useMemo(() => {
    const items = normalizedAllowed
      ? normalizedAllowed.map((path) => ({ name: filename(path), path }))
      : Object.values(directories).flatMap((state) =>
          state.nodes
            .filter((node) => node.type === "file")
            .map(({ name, path }) => ({ name, path }))
        )
    return uniqueSearchItems(items)
  }, [directories, normalizedAllowed])
  const localSearchMatches = React.useMemo(
    () => searchDevelopmentFiles(searchItems, query).map((item) => item.path),
    [query, searchItems]
  )
  const searching = query.trim().length > 0
  const searchMatches = remoteSearchMatches ?? localSearchMatches

  React.useEffect(() => {
    if (!searching || normalizedAllowed || !searchFiles) {
      setRemoteSearchMatches(null)
      setSearchLoading(false)
      return
    }

    const request = ++searchRequestRef.current
    setRemoteSearchMatches([])
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void searchFiles(query.trim())
        .then((nodes) => {
          if (request !== searchRequestRef.current) return
          setRemoteSearchMatches(
            nodes
              ?.filter((node) => node.type === "file")
              .map((node) => node.path) ?? null
          )
        })
        .catch(() => {
          if (request !== searchRequestRef.current) return
          setRemoteSearchMatches([])
        })
        .finally(() => {
          if (request === searchRequestRef.current) setSearchLoading(false)
        })
    }, 80)

    return () => {
      window.clearTimeout(timer)
      searchRequestRef.current += 1
    }
  }, [normalizedAllowed, query, searchFiles, searching])

  const load = React.useCallback(
    async (path: string) => {
      if (normalizedAllowed) return
      if (directories[path]?.loading || directories[path]?.nodes) return
      setDirectories((current) => ({
        ...current,
        [path]: { loading: true, nodes: [] },
      }))
      try {
        const nodes = await listDirectory(path)
        setDirectories((current) => ({
          ...current,
          [path]: { loading: false, nodes },
        }))
      } catch (error) {
        setDirectories((current) => ({
          ...current,
          [path]: {
            loading: false,
            nodes: [],
            error:
              error instanceof Error ? error.message : "Unable to list files",
          },
        }))
      }
    },
    [directories, listDirectory, normalizedAllowed]
  )

  const refresh = React.useCallback(
    async (path: string) => {
      try {
        const nodes = await listDirectory(path)
        setDirectories((current) => ({
          ...current,
          [path]: { loading: false, nodes },
        }))
      } catch (error) {
        setDirectories((current) => ({
          ...current,
          [path]: {
            loading: false,
            nodes: current[path]?.nodes ?? [],
            error:
              error instanceof Error ? error.message : "Unable to list files",
          },
        }))
      }
    },
    [listDirectory]
  )

  React.useEffect(() => {
    void load("")
  }, [load])

  React.useEffect(() => {
    if (normalizedAllowed) return
    if (!reloadKey) return
    if (refreshedKeyRef.current === reloadKey) return
    refreshedKeyRef.current = reloadKey
    Object.keys(directories).forEach((path) => {
      void refresh(path)
    })
  }, [directories, normalizedAllowed, refresh, reloadKey])

  React.useEffect(() => {
    if (!normalizedAllowed) return
    setExpanded(new Set(["", ...normalizedAllowed.flatMap(parentPaths)]))
  }, [normalizedAllowed])

  React.useEffect(() => {
    if (!searching) return
    setExpanded(new Set(["", ...searchMatches.flatMap(parentPaths)]))
  }, [searchMatches, searching])

  const toggle = React.useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const nodesForPath = React.useCallback(
    (path: string) =>
      normalizedAllowed
        ? syntheticNodes(path, normalizedAllowed)
        : (directories[path]?.nodes ?? []),
    [directories, normalizedAllowed]
  )

  return (
    <div
      className={cn(
        "group/filetree flex min-h-0 flex-col gap-0.5 py-2",
        className
      )}
    >
      {controlledQuery === undefined && (
        <div className="px-2 pb-1">
          <InputGroup className="h-8! bg-background/60">
            <InputGroupAddon className="pl-2">
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search files"
              className="h-7 text-xs"
              placeholder="Search files"
              type="text"
              value={query}
              onChange={(event) => {
                setRemoteSearchMatches(null)
                setQuery(event.target.value)
              }}
            />
            {query && (
              <InputGroupAddon align="inline-end" className="pr-1">
                <InputGroupButton
                  aria-label="Clear file search"
                  className="text-muted-foreground hover:text-foreground"
                  size="icon-xs"
                  onClick={() => {
                    setRemoteSearchMatches(null)
                    setQuery("")
                  }}
                >
                  <XIcon className="size-3" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
      )}
      {searchLoading ? (
        <TreeSkeleton />
      ) : searching && searchMatches.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          No matching files
        </div>
      ) : (
        <TreeLevel
          active={active}
          chain={[""]}
          directoryState={directories}
          expanded={expanded}
          kinds={kinds}
          level={0}
          load={load}
          modified={modifiedSet}
          nodesForPath={
            searching
              ? (path) => syntheticNodes(path, searchMatches)
              : nodesForPath
          }
          onFileClick={onFileClick}
          path=""
          toggle={toggle}
        />
      )}
    </div>
  )
}

function TreeLevel({
  active,
  chain,
  directoryState,
  expanded,
  kinds,
  level,
  load,
  modified,
  nodesForPath,
  onFileClick,
  path,
  toggle,
}: {
  active?: string
  chain: string[]
  directoryState: Record<string, DirectoryState>
  expanded: Set<string>
  kinds?: Map<string, DevelopmentDiffKind>
  level: number
  load: (path: string) => Promise<void>
  modified: Set<string>
  nodesForPath: (path: string) => FileNode[]
  onFileClick: (path: string) => void
  path: string
  toggle: (path: string) => void
}) {
  const state = directoryState[path]

  if (state?.loading) return <TreeSkeleton />
  if (state?.error) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        {state.error}
      </div>
    )
  }

  return nodesForPath(path).map((node) => (
    <TreeNode
      active={active}
      chain={chain}
      directoryState={directoryState}
      expanded={expanded}
      key={node.path}
      kinds={kinds}
      level={level}
      load={load}
      modified={modified}
      node={node}
      nodesForPath={nodesForPath}
      onFileClick={onFileClick}
      toggle={toggle}
    />
  ))
}

function TreeNode({
  active,
  chain,
  directoryState,
  expanded,
  kinds,
  level,
  load,
  modified,
  node,
  nodesForPath,
  onFileClick,
  toggle,
}: {
  active?: string
  chain: string[]
  directoryState: Record<string, DirectoryState>
  expanded: Set<string>
  kinds?: Map<string, DevelopmentDiffKind>
  level: number
  load: (path: string) => Promise<void>
  modified: Set<string>
  node: FileNode
  nodesForPath: (path: string) => FileNode[]
  onFileClick: (path: string) => void
  toggle: (path: string) => void
}) {
  const open = expanded.has(node.path)
  const kind = kinds?.get(node.path)
  const marked = modified.has(node.path) || Boolean(kind)
  const nextChain = [...chain, node.path]

  React.useEffect(() => {
    if (node.type !== "directory" || !open) return
    void load(node.path)
  }, [load, node.path, node.type, open])

  if (node.type === "directory") {
    const tooDeep = level >= maxDepth || chain.includes(node.path)

    return (
      <div className="relative flex flex-col gap-0.5">
        <TreeRow
          active={active === node.path}
          kind={kind}
          level={level}
          node={node}
          onClick={() => toggle(node.path)}
          type="directory"
          open={open}
        />
        {open &&
          (tooDeep ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">...</div>
          ) : (
            <div className="relative pt-0.5">
              <span
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-border opacity-0 transition-opacity group-hover/filetree:opacity-60"
                style={{ left: `${Math.max(0, 8 + level * 12 - 4) + 8}px` }}
              />
              <TreeLevel
                active={active}
                chain={nextChain}
                directoryState={directoryState}
                expanded={expanded}
                kinds={kinds}
                level={level + 1}
                load={load}
                modified={modified}
                nodesForPath={nodesForPath}
                onFileClick={onFileClick}
                path={node.path}
                toggle={toggle}
              />
            </div>
          ))}
      </div>
    )
  }

  return (
    <TreeRow
      active={active === node.path}
      kind={marked ? kind : undefined}
      level={level}
      node={node}
      onClick={() => onFileClick(node.path)}
      type="file"
    />
  )
}

function TreeRow({
  active,
  kind,
  level,
  node,
  onClick,
  open,
  type,
}: {
  active: boolean
  kind?: DevelopmentDiffKind
  level: number
  node: FileNode
  onClick: () => void
  open?: boolean
  type: "directory" | "file"
}) {
  const kindColor = diffKindColor(kind)
  const kindDotColor = diffKindDotColor(kind)
  const marked = Boolean(kind) && !node.ignored

  return (
    <button
      className={cn(
        "flex h-6 w-full min-w-0 cursor-pointer items-center justify-start gap-1.5 rounded-md px-1.5 py-0 text-left text-xs transition-colors hover:bg-muted active:bg-muted/80",
        active && "bg-muted text-foreground",
        !active && !marked && "text-muted-foreground",
        marked && "text-foreground"
      )}
      draggable={type === "file"}
      style={{ paddingLeft: `${treeRowPadding(level, type)}px` }}
      type="button"
      onDragStart={(event) => {
        if (type !== "file") return
        event.dataTransfer.setData("text/plain", `file:${node.path}`)
        event.dataTransfer.setData(
          "text/uri-list",
          `file://${encodeURI(node.path)}`
        )
        event.dataTransfer.effectAllowed = "copy"
      }}
      onClick={onClick}
    >
      {type === "directory" ? (
        open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <TreeIcon
        kindColor={kindColor}
        marked={marked}
        node={node}
        open={open}
        type={type}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium whitespace-nowrap",
          node.ignored && "text-muted-foreground/60",
          marked && kindColor
        )}
      >
        {node.name}
      </span>
      {kind && type === "file" && (
        <span
          className={cn(
            "w-4 shrink-0 text-center text-xs font-medium",
            kindColor
          )}
        >
          {diffKindLabel(kind)}
        </span>
      )}
      {kind && type === "directory" && (
        <span
          className={cn("mr-1.5 size-1.5 shrink-0 rounded-full", kindDotColor)}
        />
      )}
    </button>
  )
}

function TreeIcon({
  kindColor,
  marked,
  node,
  open,
  type,
}: {
  kindColor?: string
  marked: boolean
  node: FileNode
  open?: boolean
  type: "directory" | "file"
}) {
  if (node.ignored || marked) {
    return (
      <DevelopmentFileIcon
        className={cn(
          "shrink-0",
          node.ignored && "text-muted-foreground/60",
          marked && kindColor
        )}
        expanded={open}
        mono
        node={node}
      />
    )
  }

  if (type === "directory") {
    return (
      <DevelopmentFileIcon className="shrink-0" expanded={open} node={node} />
    )
  }

  return (
    <span className="relative size-4 shrink-0">
      <DevelopmentFileIcon
        className="absolute inset-0 opacity-0 transition-opacity group-hover/filetree:opacity-100"
        node={node}
      />
      <DevelopmentFileIcon
        className="absolute inset-0 text-muted-foreground transition-opacity group-hover/filetree:opacity-0"
        mono
        node={node}
      />
    </span>
  )
}

function treeRowPadding(level: number, type: "directory" | "file") {
  return Math.max(0, 8 + level * 12 - (type === "file" ? 24 : 4))
}

function diffKindColor(kind?: DevelopmentDiffKind) {
  if (kind === "add") return "text-emerald-600 dark:text-emerald-400"
  if (kind === "del") return "text-destructive"
  if (kind === "mix") return "text-amber-600 dark:text-amber-400"
  return undefined
}

function diffKindDotColor(kind?: DevelopmentDiffKind) {
  if (kind === "add") return "bg-emerald-500"
  if (kind === "del") return "bg-destructive"
  if (kind === "mix") return "bg-amber-500"
  return undefined
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-4/5" />
    </div>
  )
}

function parentPaths(path: string) {
  return path
    .split("/")
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
    .filter(Boolean)
}

function syntheticNodes(path: string, files: string[]) {
  const nodes = new Map<string, FileNode>()
  files.forEach((file) => addSyntheticNode(nodes, path, file))
  return [...nodes.values()].sort(sortNodes)
}

function addSyntheticNode(
  nodes: Map<string, FileNode>,
  path: string,
  file: string
) {
  const prefix = path ? `${path}/` : ""
  if (path && !file.startsWith(prefix)) return
  const rest = path ? file.slice(prefix.length) : file
  const part = rest.split("/")[0]
  if (!part) return
  const child = prefix + part
  const type = rest.includes("/") ? "directory" : "file"
  nodes.set(child, {
    absolute: child,
    ignored: false,
    name: filename(child),
    path: child,
    type,
  })
}

function sortNodes(a: FileNode, b: FileNode) {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  return a.name.localeCompare(b.name)
}

function uniqueSearchItems(items: DevelopmentFileSearchItem[]) {
  return [...new Map(items.map((item) => [item.path, item])).values()]
}
