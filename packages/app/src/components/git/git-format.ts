import { cn } from "@/lib/utils"
import type { GitLogCommitRef } from "@/context/platform"

export function shortGitHash(hash: string) {
  return hash.slice(0, 9)
}

export function gitRefClassName(type: string) {
  if (type === "head") return "bg-blue-500/15 text-blue-700 dark:text-blue-300"
  if (type === "tag")
    return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
  if (type === "remote")
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
  return "bg-foreground/8 text-foreground/80"
}

const primaryRefNames = new Set([
  "HEAD",
  "main",
  "master",
  "origin/HEAD",
  "origin/main",
  "origin/master",
])

// Refs worth a label first: HEAD, tags and the main branches.
export function primaryGitRef(ref: GitLogCommitRef) {
  return (
    ref.type === "head" || ref.type === "tag" || primaryRefNames.has(ref.name)
  )
}

export function visibleGitRefs(refs: readonly GitLogCommitRef[], max: number) {
  const ordered = [
    ...refs.filter(primaryGitRef),
    ...refs.filter((ref) => !primaryGitRef(ref)),
  ]
  return {
    hidden: Math.max(0, refs.length - max),
    visible: ordered.slice(0, max),
  }
}

// Text color of a changed file, as in IntelliJ and VS Code: green for new
// files, blue for edits, red for deletions and conflicts.
export function gitStatusTextClassName(status: string) {
  return cn(
    (status === "added" || status === "untracked" || status === "copied") &&
      "text-emerald-600 dark:text-emerald-400",
    status === "modified" && "text-sky-600 dark:text-sky-400",
    status === "renamed" && "text-violet-600 dark:text-violet-400",
    (status === "deleted" || status === "conflict") &&
      "text-red-600 dark:text-red-400"
  )
}

export function gitStatusLabel(status: string) {
  if (status === "added") return "A"
  if (status === "copied") return "C"
  if (status === "deleted") return "D"
  if (status === "renamed") return "R"
  if (status === "untracked") return "U"
  if (status === "conflict") return "!"
  return "M"
}

export function gitStatusName(status: string) {
  if (status === "added") return "Added"
  if (status === "copied") return "Copied"
  if (status === "deleted") return "Deleted"
  if (status === "renamed") return "Renamed"
  if (status === "untracked") return "Untracked"
  if (status === "conflict") return "Conflict"
  return "Modified"
}

export function gitDateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date)
}

export function gitRelativeDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diff = date.getTime() - Date.now()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (Math.abs(diff) < hour)
    return relative(Math.round(diff / minute), "minute")
  if (Math.abs(diff) < day) return relative(Math.round(diff / hour), "hour")
  return relative(Math.round(diff / day), "day")
}

function relative(value: number, unit: Intl.RelativeTimeFormatUnit) {
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    value,
    unit
  )
}
