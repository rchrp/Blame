// What a tool call looks like on screen, independent of React.
//
// The collapsed row reads as a sentence: a verb, a target and a few chips
// ("Edited sync-service.ts +12 −3"). Opening it shows bodies picked for that
// tool: a diff for edits, a terminal for commands, hits for searches.

export type ToolCallFamily =
  | "agent"
  | "command"
  | "edit"
  | "finish"
  | "graph"
  | "list"
  | "other"
  | "preview"
  | "question"
  | "read"
  | "search"
  | "skill"
  | "test"
  | "web"

export type ToolCallTone =
  | "neutral"
  | "success"
  | "danger"
  | "warning"
  | "add"
  | "remove"

export type ToolCallChip = {
  label: string
  tone?: ToolCallTone
  mono?: boolean
  title?: string
}

export type DiffLine = {
  kind: "add" | "remove" | "context" | "hunk"
  text: string
}

export type DiffFile = {
  path: string
  additions?: number
  deletions?: number
  status?: "added" | "deleted" | "modified" | "renamed"
  note?: string
  lines: DiffLine[]
}

export type SearchHit = {
  path: string
  line?: number
  kind?: string
  name?: string
  snippet?: string
}

export type TestCounts = {
  passed?: number
  failed?: number
  skipped?: number
  total?: number
}

export type ToolCallBody =
  | {
      type: "code"
      path?: string
      label?: string
      startLine?: number
      text: string
      truncated?: boolean
    }
  | { type: "diff"; files: DiffFile[]; truncated?: boolean }
  | {
      type: "terminal"
      command?: string
      cwd?: string
      output?: string
      exitCode?: number
      truncated?: boolean
    }
  | { type: "search"; hits: SearchHit[]; more?: number }
  | {
      type: "files"
      files: { path: string; detail?: string; kind?: "file" | "directory" }[]
      more?: number
    }
  | { type: "tests"; counts: TestCounts; outcome?: string }
  | { type: "text"; label?: string; text: string; truncated?: boolean }
  | {
      type: "fields"
      fields: { label: string; value: string; mono?: boolean }[]
    }
  | { type: "list"; label?: string; items: string[] }
  | { type: "error"; message: string; recovery?: string }
  | { type: "screenshot"; screenshots: ScreenshotRef[]; pending?: boolean }

// A screenshot stored by the desktop app, as referenced by a tool result.
export type ScreenshotRef = {
  colorScheme: "dark" | "light"
  height: number
  id: string
  mimeType: string
  pageUrl: string
  sessionId?: string
  viewport: { height: number; width: number }
  width: number
}

export type ToolCallView = {
  family: ToolCallFamily
  // "Read", "Edited", "Ran"… or the present tense while running.
  verb: string
  target?: {
    text: string
    mono?: boolean
    title?: string
  }
  chips: ToolCallChip[]
  bodies: ToolCallBody[]
  failed: boolean
}

export type ToolCallSource = {
  toolName?: string
  input: unknown
  output: unknown
  update?: unknown
  running: boolean
  durationMs?: number
  agentName?: string
  title: string
  kind: string
  detail: string
}
