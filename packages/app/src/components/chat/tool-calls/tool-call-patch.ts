import type { DiffFile, DiffLine } from "./tool-call-view.ts"

// Parses Cline patches ("*** Begin Patch / *** Update File: … / *** End Patch")
// into per-file diff lines with addition and deletion counts.
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | undefined

  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/u)
    if (header) {
      current = {
        path: header[2]!.trim(),
        additions: 0,
        deletions: 0,
        status:
          header[1] === "Add"
            ? "added"
            : header[1] === "Delete"
              ? "deleted"
              : "modified",
        lines: [],
      }
      files.push(current)
      continue
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/u)
    if (move && current) {
      current.note = `Moved to ${move[1]!.trim()}`
      current.status = "renamed"
      continue
    }
    if (!current) continue
    if (/^\*\*\* (Begin|End) Patch/u.test(line) || line.startsWith("*** End of File")) {
      continue
    }
    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line.slice(2).trim() })
      continue
    }
    if (line.startsWith("+")) {
      current.additions = (current.additions ?? 0) + 1
      current.lines.push({ kind: "add", text: line.slice(1) })
      continue
    }
    if (line.startsWith("-")) {
      current.deletions = (current.deletions ?? 0) + 1
      current.lines.push({ kind: "remove", text: line.slice(1) })
      continue
    }
    current.lines.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
    })
  }

  for (const file of files) trimContext(file.lines)
  return files
}

export function isPatchText(text: string) {
  return /^\s*\*\*\* Begin Patch/u.test(text) || /^\*\*\* (Update|Add|Delete) File:/mu.test(text)
}

// A whole new file shown as additions.
export function addedFile(path: string, text: string): DiffFile {
  const lines = text.replace(/\n$/u, "").split("\n")
  return {
    path,
    additions: lines.length,
    deletions: 0,
    status: "added",
    lines: lines.map((line) => ({ kind: "add", text: line })),
  }
}

// A find-and-replace edit shown as a small diff.
export function replacementFile(
  path: string,
  oldText: string | undefined,
  newText: string
): DiffFile {
  const removed = oldText ? oldText.replace(/\n$/u, "").split("\n") : []
  const added = newText.replace(/\n$/u, "").split("\n")
  return {
    path,
    additions: added.length,
    deletions: removed.length,
    status: "modified",
    lines: [
      ...removed.map((line): DiffLine => ({ kind: "remove", text: line })),
      ...added.map((line): DiffLine => ({ kind: "add", text: line })),
    ],
  }
}

// Drops blank context lines at the start and end of a file's diff.
function trimContext(lines: DiffLine[]) {
  while (lines.length && lines[0]!.kind === "context" && !lines[0]!.text.trim()) {
    lines.shift()
  }
  while (
    lines.length &&
    lines[lines.length - 1]!.kind === "context" &&
    !lines[lines.length - 1]!.text.trim()
  ) {
    lines.pop()
  }
}
