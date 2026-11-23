// "Bring your setup": what the person already has in other agent tools
// (Claude Desktop, Claude Code, Codex, Cursor, VS Code) and can import into
// Blame. The main process reads the files and does the import; the renderer
// only ever sees masked summaries. A secret (a token in an `env` entry or a
// header) never crosses this boundary: the person ticks items by id and main
// re-reads the source files to import them.

export type AgentImportSourceId =
  | "claude-desktop"
  | "claude-code"
  | "codex"
  | "cursor"
  | "vscode"
  | "cline"
  | "opencode"
  | "kilo"
  | "roo"
  | "gemini"
  | "qwen"
  | "goose"
  | "continue"
  | "zed"

export type AgentImportCategory = "mcp" | "skill" | "command"

/**
 * - `new`: not in Blame yet; can be imported.
 * - `conflict`: Blame has something of this name that is not the same; the
 *   person skips it (the default) or imports it under another name.
 * - `present`: Blame already has it (an earlier import, or added by hand).
 * - `in-place`: Blame reads it where it is; nothing to import.
 */
export type AgentImportItemState = "new" | "conflict" | "present" | "in-place"

export type AgentImportItem = {
  /** Stable across scans: `<source>:<category>:<key>`. */
  id: string
  category: AgentImportCategory
  name: string
  state: AgentImportItemState
  /** What it runs or reaches, secrets masked (`npx -y @dokploy/mcp`). */
  summary: string
  /** Where in the source it was found (a project's path, a plugin…). */
  scope?: string
  /** Names of the environment variables and headers whose values are hidden. */
  secrets: string[]
  /** What will not carry over exactly (unexpanded variables, OAuth…). */
  warnings: string[]
  /** Ticked when the review opens. */
  defaultSelected: boolean
  /** The name used when the person renames a conflicting item. */
  renameTo?: string
}

/** Something found that Blame has no equivalent for, said honestly. */
export type AgentImportUnsupported = {
  label: string
  count: number
  reason: string
}

export type AgentImportSource = {
  id: AgentImportSourceId
  label: string
  /** The tool's files were found on this computer. */
  detected: boolean
  /** The folder or file the source was read from, for the person's eyes. */
  location: string
  items: AgentImportItem[]
  unsupported: AgentImportUnsupported[]
}

/** Every source Blame knows, found or not, so the first screen can show all. */
export type AgentImportScan = {
  sources: AgentImportSource[]
}

export type AgentImportChoice = {
  id: string
  /** Import under the item's `renameTo` instead of skipping a conflict. */
  rename?: boolean
}

export type AgentImportOutcome = {
  id: string
  name: string
  status: "imported" | "renamed" | "present" | "skipped" | "failed"
  message?: string
}

export type AgentImportResult = {
  outcomes: AgentImportOutcome[]
}

export type AgentImportClient = {
  /** Reads the other tools' files, read-only; nothing is started. */
  scan(): Promise<AgentImportScan>
  /** Imports the ticked items. Re-reads the sources: no secret comes back. */
  apply(choices: AgentImportChoice[]): Promise<AgentImportResult>
}
