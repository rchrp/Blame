import {
  addedFile,
  isPatchText,
  parsePatch,
  replacementFile,
} from "./tool-call-patch.ts"
import {
  basename,
  harnessResult,
  lineCount,
  list,
  num,
  operationResults,
  pair,
  plural,
  record,
  str,
  strings,
  textOf,
  type HarnessResult,
} from "./tool-call-values.ts"
import type {
  DiffFile,
  SearchHit,
  ToolCallBody,
  ToolCallChip,
  ToolCallSource,
  ToolCallView,
} from "./tool-call-view.ts"

// Read, search and edit tools: everything that touches source files.

export function describeRead(source: ToolCallSource): ToolCallView {
  const harness = harnessResult(source.output)
  if (source.toolName === "read_files") return describeClineRead(source)
  const input = record(source.input)
  const data = harness?.data ?? {}
  const target = str(input.target) ?? ""
  const path = str(data.path) ?? pathFromTarget(target)
  const verb = source.running ? "Reading" : "Read"

  if (target === "@changes") {
    return simple("read", source.running ? "Reviewing" : "Reviewed", "current changes", harness, dataBodies(data))
  }
  if (target === "@checks") {
    return simple("read", source.running ? "Reviewing" : "Reviewed", "available checks", harness, dataBodies(data))
  }
  if (target === "@capabilities") {
    return simple("read", source.running ? "Checking" : "Checked", "workspace capabilities", harness, dataBodies(data))
  }

  if (str(data.view) === "directory" || Array.isArray(data.entries)) {
    const entries = list(data.entries).map((entry) => {
      const item = record(entry)
      const entryPath = str(item.target) ?? str(item.path) ?? ""
      return {
        path: entryPath,
        kind: str(item.kind) === "directory" ? ("directory" as const) : ("file" as const),
      }
    })
    const count = num(data.candidateCount) ?? entries.length
    return {
      family: "list",
      verb: source.running ? "Listing" : "Listed",
      target: { text: `${path || target}/`, mono: true, title: path || target },
      chips: harness?.failed ? [] : [{ label: plural(count, "entry", "entries") }],
      bodies: withError(harness, entries.length ? [{ type: "files", files: entries, more: Math.max(count - entries.length, 0) }] : []),
      failed: Boolean(harness?.failed),
    }
  }

  const symbol = str(data.qualifiedName) ?? symbolFromTarget(target)
  const lines = pair(data.lines) ?? pair(data.line_range)
  const range = record(input.range)
  const startLine = lines?.[0] ?? num(range.startLine)
  const endLine = lines?.[1] ?? num(range.endLine)
  const view = str(data.view) ?? str(input.view)
  const content = textOf(data.content)
  const body = textOf(data.body)
  const signature = str(data.signature)
  const chips: ToolCallChip[] = []

  if (symbol && path) chips.push({ label: basename(path), mono: true, title: path })
  if (startLine !== undefined && endLine !== undefined) {
    chips.push({ label: `L${startLine}–${endLine}` })
  } else if (view === "outline") {
    chips.push({ label: "Outline" })
  } else if (view === "signature") {
    chips.push({ label: "Signature" })
  } else if (content && data.complete === true) {
    chips.push({ label: plural(lineCount(content.text), "line") })
  }
  if (str(data.status) === "already_available" || str(data.status) === "already_in_context") {
    chips.push({ label: "Already in context" })
  }

  const bodies: ToolCallBody[] = []
  const code = body
    ? { text: `${signature ? `${signature.trim()} ` : ""}${body.text}`, truncated: body.truncated }
    : content
  if (code) {
    bodies.push({
      type: "code",
      path,
      startLine: body ? (startLine ?? undefined) : (startLine ?? 1),
      text: code.text,
      truncated: code.truncated || data.truncated === true,
    })
  } else if (signature) {
    bodies.push({ type: "code", path, text: signature })
  }
  const outline = list(data.editTargets ?? data.symbols)
  if (!code && outline.length) {
    bodies.push({
      type: "list",
      label: "Symbols",
      items: outline.flatMap((entry) => {
        const name = str(record(entry).qualifiedName) ?? str(record(entry).name)
        return name ? [name] : []
      }),
    })
  }

  return {
    family: "read",
    verb,
    target: symbol
      ? { text: symbol, mono: true, title: path ? `${path}#${symbol}` : symbol }
      : { text: basename(path || target || "file"), mono: true, title: path || target },
    chips,
    bodies: withError(harness, bodies),
    failed: Boolean(harness?.failed),
  }
}

function describeClineRead(source: ToolCallSource): ToolCallView {
  const files = clineReadRequests(source.input)
  const results = operationResults(source.output)
  const failed = results.some((result) => result.success === false)
  const verb = source.running ? "Reading" : "Read"
  const bodies: ToolCallBody[] = results.flatMap((result, index): ToolCallBody[] => {
    const request = files[index]
    if (result.success === false) {
      return [{ type: "error", message: result.error ?? `Could not read ${result.query ?? "the file"}.` }]
    }
    if (!result.result) return []
    return [
      {
        type: "code",
        path: request?.path ?? result.query,
        startLine: request?.startLine ?? 1,
        text: result.result.text,
        truncated: result.result.truncated,
      },
    ]
  })

  if (files.length <= 1) {
    const file = files[0]
    const chips: ToolCallChip[] = []
    if (file?.startLine !== undefined || file?.endLine !== undefined) {
      chips.push({ label: `L${file.startLine ?? 1}–${file.endLine ?? "end"}` })
    } else if (results[0]?.result && !results[0].result.truncated) {
      chips.push({ label: plural(lineCount(results[0].result.text), "line") })
    }
    return {
      family: "read",
      verb,
      target: { text: basename(file?.path ?? results[0]?.query ?? "file"), mono: true, title: file?.path },
      chips,
      bodies,
      failed,
    }
  }

  return {
    family: "read",
    verb,
    target: { text: fileSummary(files.map((file) => file.path)), mono: true, title: files.map((file) => file.path).join("\n") },
    chips: [{ label: plural(files.length, "file") }],
    bodies,
    failed,
  }
}

export function describeSearch(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  if (source.toolName === "search_codebase") {
    const queries = typeof source.input === "string" ? [source.input] : strings(input.queries ?? source.input)
    const results = operationResults(source.output)
    const matches = results.reduce((total, result) => total + countMatches(result.result?.text), 0)
    return {
      family: "search",
      verb: source.running ? "Searching for" : "Searched for",
      target: { text: queries.map((query) => `"${query}"`).join(", ") || "code", mono: true },
      chips: results.length ? [{ label: matches ? plural(matches, "match", "matches") : "No matches", tone: matches ? "neutral" : "warning" }] : [],
      bodies: results.flatMap((result): ToolCallBody[] =>
        result.result ? [{ type: "code", label: result.query, text: result.result.text, truncated: result.result.truncated }] : []
      ),
      failed: results.some((result) => result.success === false),
    }
  }

  const harness = harnessResult(source.output)
  const data = harness?.data ?? {}
  const query = str(input.query) ?? str(record(input.query).name) ?? str(record(input.query).pattern) ?? ""
  const mode = str(input.mode) ?? str(data.mode)
  const hits: SearchHit[] = list(data.results ?? data.matches).flatMap((entry): SearchHit[] => {
    const item = record(entry)
    const path = str(item.path)
    if (!path) return []
    const lines = pair(item.lines)
    return [
      {
        path,
        line: lines?.[0] ?? num(item.line),
        kind: str(item.kind),
        name: str(item.qualifiedName) ?? str(item.name),
        snippet: str(item.signature) ?? str(item.preview) ?? str(item.text),
      },
    ]
  })
  const total = num(data.candidateCount) ?? hits.length
  const scope = strings(Array.isArray(input.scope) ? input.scope : input.scope ? [input.scope] : [])
  const chips: ToolCallChip[] = []
  if (harness && !harness.failed) {
    chips.push({ label: hits.length ? plural(total, "result") : "No results", tone: hits.length ? "neutral" : "warning" })
  }
  if (scope.length) chips.push({ label: `in ${scope.join(", ")}`, mono: true })

  return {
    family: "search",
    verb:
      mode === "references"
        ? source.running ? "Finding references to" : "Found references to"
        : source.running ? "Searching for" : "Searched for",
    target: { text: mode === "references" ? query : `"${query}"`, mono: true },
    chips,
    bodies: withError(harness, hits.length ? [{ type: "search", hits, more: Math.max(total - hits.length, 0) }] : []),
    failed: Boolean(harness?.failed),
  }
}

export function describeEdit(source: ToolCallSource): ToolCallView {
  const harness = harnessResult(source.output)
  const files = editedFiles(source)
  const changes = list(harness?.data.changes ?? harness?.data.files)
  const counts = new Map(
    changes.flatMap((entry) => {
      const item = record(entry)
      const path = str(item.path)
      return path ? [[path, item] as const] : []
    })
  )
  // Prefer the runtime's counts over the ones parsed from the patch.
  for (const file of files) {
    const reported = counts.get(file.path)
    if (!reported) continue
    file.additions = num(reported.additions) ?? file.additions
    file.deletions = num(reported.deletions) ?? file.deletions
  }
  for (const [path, item] of counts) {
    if (files.some((file) => file.path === path)) continue
    files.push({ path, additions: num(item.additions), deletions: num(item.deletions), lines: [] })
  }

  const clineFailure = operationResults(source.output).find((result) => result.success === false)
  const failed = Boolean(harness?.failed || clineFailure)
  const symbols = changes.flatMap((entry) => list(record(entry).symbols)).filter(
    (symbol): symbol is string => typeof symbol === "string"
  )
  const rename = symbolOperations(source.input).find((operation) => operation.action === "rename")
  const allNew = files.length > 0 && files.every((file) => file.status === "added")
  const allDeleted = files.length > 0 && files.every((file) => file.status === "deleted")
  const verb = source.running
    ? rename ? "Renaming" : allNew ? "Creating" : "Editing"
    : rename ? "Renamed" : allNew ? "Created" : allDeleted ? "Deleted" : "Edited"

  const additions = sum(files.map((file) => file.additions))
  const deletions = sum(files.map((file) => file.deletions))
  const chips: ToolCallChip[] = []
  if (additions !== undefined) chips.push({ label: `+${additions}`, tone: "add" })
  if (deletions !== undefined && !allNew) chips.push({ label: `−${deletions}`, tone: "remove" })
  if (symbols.length === 1 && !rename) chips.push({ label: `in ${symbols[0]}`, mono: true })
  const parse = str(record(harness?.data.parse).status)
  if (parse === "failed") chips.push({ label: "Syntax error", tone: "danger" })

  const bodies: ToolCallBody[] = []
  if (harness?.failed) {
    bodies.push({ type: "error", message: harness.message ?? "The edit was not applied.", recovery: harness.recovery })
  } else if (clineFailure) {
    bodies.push({ type: "error", message: clineFailure.error ?? "The edit was not applied." })
  }
  const symbolBodies = symbolOperations(source.input).flatMap((operation): ToolCallBody[] =>
    operation.content && operation.action !== "rename"
      ? [{ type: "code", label: `${symbolActionLabel(operation.action)} ${operation.target}`, text: operation.content }]
      : []
  )
  if (files.some((file) => file.lines.length)) {
    bodies.push({ type: "diff", files })
  } else if (files.length > 1) {
    bodies.push({
      type: "files",
      files: files.map((file) => ({ path: file.path, detail: diffStat(file) })),
    })
  }
  bodies.push(...symbolBodies)

  const target = rename
    ? { text: `${rename.target} → ${rename.content ?? "?"}`, mono: true }
    : files.length === 1
      ? { text: basename(files[0]!.path), mono: true, title: files[0]!.path }
      : files.length > 1
        ? { text: plural(files.length, "file"), title: files.map((file) => file.path).join("\n") }
        : { text: "code", mono: false }

  return { family: "edit", verb, target, chips, bodies, failed }
}

function editedFiles(source: ToolCallSource): DiffFile[] {
  const input = record(source.input)
  if (source.toolName === "editor") {
    const path = str(input.path) ?? "file"
    const newText = textOf(input.new_text)?.text ?? ""
    const oldText = textOf(input.old_text)?.text
    if (!oldText && num(input.insert_line) === undefined) return [addedFile(path, newText)]
    const file = replacementFile(path, oldText, newText)
    if (num(input.insert_line) !== undefined) file.note = `Inserted at line ${num(input.insert_line)}`
    return [file]
  }
  if (source.toolName === "write_file") {
    const path = str(input.path) ?? str(input.file_path) ?? "file"
    return [addedFile(path, textOf(input.content)?.text ?? "")]
  }
  if (source.toolName === "apply_patch") {
    const patch = typeof source.input === "string" ? source.input : textOf(input.input)?.text
    if (patch) return parsePatch(patch)
    return list(input.files).flatMap((entry) => {
      const path = str(record(entry).path)
      return path ? [{ path, additions: num(record(entry).additions), deletions: num(record(entry).deletions), lines: [] }] : []
    })
  }
  return list(input.operations).flatMap((entry): DiffFile[] => {
    const operation = record(entry)
    const patch = textOf(operation.patch)?.text
    if (!patch) return []
    if (isPatchText(patch)) return parsePatch(patch)
    return [addedFile(str(operation.path) ?? "file", patch)]
  })
}

function symbolOperations(input: unknown) {
  return list(record(input).operations).flatMap((entry) => {
    const operation = record(entry)
    if (str(operation.kind) !== "symbol") return []
    return [
      {
        action: str(operation.action) ?? "replace",
        target: str(operation.target) ?? "symbol",
        content: textOf(operation.content)?.text,
      },
    ]
  })
}

function symbolActionLabel(action: string) {
  if (action === "replace_body") return "New body of"
  if (action === "insert_before") return "Inserted before"
  if (action === "insert_after") return "Inserted after"
  if (action === "delete") return "Deleted"
  return "Replaced"
}

function clineReadRequests(input: unknown) {
  const value = record(input)
  const entries = typeof input === "string" ? [input] : Array.isArray(input) ? input : list(value.files ?? (value.path || value.file_path ? [value] : []))
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [{ path: entry, startLine: undefined, endLine: undefined }]
    const item = record(entry)
    const path = str(item.path) ?? str(item.file_path) ?? str(item.filePath)
    return path ? [{ path, startLine: num(item.start_line), endLine: num(item.end_line) }] : []
  })
}

function countMatches(text: string | undefined) {
  if (!text) return 0
  const found = text.match(/Found (\d+) (?:results?|matches?)/iu)
  if (found) return Number(found[1])
  return text.split("\n").filter((line) => /:\d+[:│|]/u.test(line) || /^\s*│?\s*\d+\s*│/u.test(line)).length
}

function pathFromTarget(target: string) {
  if (!target || /^s\d+$/u.test(target) || target.startsWith("@")) return ""
  return target.split("#", 1)[0] ?? ""
}

function symbolFromTarget(target: string) {
  const index = target.indexOf("#")
  return index > 0 ? target.slice(index + 1) : undefined
}

function fileSummary(paths: string[]) {
  const names = paths.map(basename)
  if (names.length <= 2) return names.join(", ")
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`
}

function diffStat(file: DiffFile) {
  const parts = []
  if (file.additions !== undefined) parts.push(`+${file.additions}`)
  if (file.deletions !== undefined) parts.push(`−${file.deletions}`)
  return parts.join(" ") || undefined
}

function sum(values: (number | undefined)[]) {
  const known = values.filter((value): value is number => value !== undefined)
  return known.length ? known.reduce((total, value) => total + value, 0) : undefined
}

function dataBodies(data: Record<string, unknown>): ToolCallBody[] {
  const text = textOf(data.content) ?? textOf(data.summary) ?? textOf(data.text)
  return text ? [{ type: "text", text: text.text, truncated: text.truncated }] : []
}

function simple(
  family: ToolCallView["family"],
  verb: string,
  target: string,
  harness: HarnessResult | undefined,
  bodies: ToolCallBody[]
): ToolCallView {
  return {
    family,
    verb,
    target: { text: target },
    chips: [],
    bodies: withError(harness, bodies),
    failed: Boolean(harness?.failed),
  }
}

export function withError(harness: HarnessResult | undefined, bodies: ToolCallBody[]): ToolCallBody[] {
  if (!harness?.failed) return bodies
  return [{ type: "error", message: harness.message ?? "The tool could not complete.", recovery: harness.recovery }, ...bodies]
}
