import { withError } from "./describe-code.ts"
import {
  firstLine,
  formatDuration,
  harnessResult,
  hostname,
  humanize,
  list,
  num,
  operationResults,
  plural,
  record,
  str,
  strings,
  stripAnsi,
  textOf,
} from "./tool-call-values.ts"
import type {
  TestCounts,
  ToolCallBody,
  ToolCallChip,
  ToolCallSource,
  ToolCallView,
} from "./tool-call-view.ts"

// Commands, tests and every tool that is not about source files.

export function describeCommand(source: ToolCallSource): ToolCallView {
  if (source.toolName === "run_commands") return describeClineCommands(source)
  const input = record(source.input)
  const kind = str(input.kind) ?? (str(input.command) ? "command" : str(input.task) ? "project" : undefined)
  const harness = harnessResult(source.output)
  const data = harness?.data ?? {}
  const output = commandOutput(data, source.update)
  const exitCode = num(data.exitCode)
  // A running command's duration is not final yet.
  const duration = source.running ? undefined : formatDuration(source.durationMs)

  if (kind === "dependency") {
    const packages = strings(input.packages)
    const remove = str(input.action) === "remove"
    return {
      family: "command",
      verb: source.running ? (remove ? "Removing" : "Installing") : remove ? "Removed" : "Installed",
      target: { text: packages.join(", ") || "dependencies", mono: true },
      chips: statusChips(harness, exitCode, duration),
      bodies: withError(harness, terminal(str(data.command), output, exitCode)),
      failed: Boolean(harness?.failed),
    }
  }

  if (kind === "inspect") {
    return {
      family: "command",
      verb: source.running ? "Checking on" : "Checked on",
      target: { text: str(data.command) ?? `task ${str(input.run) ?? ""}`.trim(), mono: Boolean(str(data.command)) },
      chips: [
        ...(str(data.state) ? [{ label: humanize(str(data.state)!) }] : []),
        ...statusChips(harness, exitCode, duration),
      ],
      bodies: withError(harness, terminal(undefined, output, exitCode)),
      failed: Boolean(harness?.failed),
    }
  }

  if (kind === "analyze") {
    const outcome = str(data.outcome) ?? str(data.status)
    return {
      family: "test",
      verb: source.running ? "Analyzing" : "Analyzed",
      target: { text: str(input.target) ?? "function", mono: true },
      chips: outcome ? [{ label: humanize(outcome), tone: outcome === "verified" || outcome === "no_counterexample" ? "success" : outcome === "counterexample" ? "danger" : "neutral" }] : [],
      bodies: withError(harness, [
        { type: "fields", fields: [{ label: "Assertion", value: str(input.assertion) ?? "", mono: true }] },
        ...(textOf(data.message) ? [{ type: "text" as const, text: textOf(data.message)!.text }] : []),
      ]),
      failed: Boolean(harness?.failed),
    }
  }

  if (kind === "project") {
    const check = record(data.check ?? data.reporting)
    const counts = testCounts(record(check.counts))
    const task = str(input.task) ?? "task"
    const args = strings(input.args)
    const chips: ToolCallChip[] = []
    if (counts) chips.push(...countChips(counts))
    else chips.push(...statusChips(harness, exitCode, undefined))
    if (duration) chips.push({ label: duration })
    const bodies: ToolCallBody[] = []
    if (counts) bodies.push({ type: "tests", counts, outcome: str(check.outcome) })
    bodies.push(...terminal(str(data.command), output, exitCode))
    return {
      family: counts ? "test" : "command",
      verb: source.running ? "Running" : "Ran",
      target: { text: [task, ...args].join(" "), mono: true, title: str(data.command) },
      chips,
      bodies: withError(harness, bodies),
      failed: Boolean(harness?.failed) || (counts?.failed ?? 0) > 0,
    }
  }

  const command = str(input.command) ?? str(data.command) ?? taskLabel(input)
  return {
    family: "command",
    verb: source.running ? "Running" : "Ran",
    target: { text: command ? firstLine(command, 90) : "command", mono: Boolean(command), title: command },
    chips: statusChips(harness, exitCode, duration),
    bodies: withError(harness, terminal(command, output, exitCode, str(input.cwd))),
    failed: Boolean(harness?.failed) || (exitCode !== undefined && exitCode !== 0),
  }
}

function describeClineCommands(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const commands = typeof source.input === "string" ? [source.input] : strings(input.commands ?? source.input)
  const results = operationResults(source.output)
  const failed = results.some((result) => result.success === false)
  const duration = source.running ? undefined : formatDuration(source.durationMs)
  const bodies: ToolCallBody[] = (results.length ? results : commands.map((command) => ({ query: command }))).flatMap(
    (result, index) => {
      const item = result as { query?: string; result?: { text: string; truncated: boolean }; error?: string; success?: boolean }
      return [
        {
          type: "terminal" as const,
          command: item.query ?? commands[index],
          output: item.result ? stripAnsi(item.result.text) : item.error,
          exitCode: item.success === false ? 1 : item.success ? 0 : undefined,
          truncated: item.result?.truncated,
        },
      ]
    }
  )
  const chips: ToolCallChip[] = []
  if (results.length) chips.push(failed ? { label: "Failed", tone: "danger" } : { label: "Done", tone: "success" })
  if (duration) chips.push({ label: duration })
  return {
    family: "command",
    verb: source.running ? "Running" : "Ran",
    target:
      commands.length === 1
        ? { text: firstLine(commands[0]!, 90), mono: true, title: commands[0] }
        : { text: plural(commands.length, "command"), title: commands.join("\n") },
    chips,
    bodies,
    failed,
  }
}

export function describeWeb(source: ToolCallSource): ToolCallView {
  const requests = list(record(source.input).requests).map((entry) => ({
    url: str(record(entry).url) ?? "",
    prompt: str(record(entry).prompt),
  }))
  const results = operationResults(source.output)
  const bodies: ToolCallBody[] = requests.flatMap((request, index): ToolCallBody[] => {
    const result = results[index]
    return [
      { type: "fields", fields: [{ label: "URL", value: request.url, mono: true }, ...(request.prompt ? [{ label: "Looking for", value: request.prompt }] : [])] },
      ...(result?.success === false
        ? [{ type: "error" as const, message: result.error ?? "The page could not be fetched." }]
        : result?.result
          ? [{ type: "text" as const, text: result.result.text, truncated: result.result.truncated }]
          : []),
    ]
  })
  return {
    family: "web",
    verb: source.running ? "Fetching" : "Fetched",
    target:
      requests.length === 1
        ? { text: hostname(requests[0]!.url), title: requests[0]!.url }
        : { text: plural(requests.length, "web page") },
    chips: [],
    bodies,
    failed: results.some((result) => result.success === false),
  }
}

export function describeSkill(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const skill = str(input.skill) ?? "skill"
  const args = str(input.args)
  const result = operationResults(source.output)[0]
  return {
    family: "skill",
    verb: source.running ? "Using skill" : "Used skill",
    target: { text: `/${skill}${args ? ` ${args}` : ""}`, mono: true },
    chips: [],
    bodies: result?.result ? [{ type: "text", text: result.result.text, truncated: result.result.truncated }] : [],
    failed: result?.success === false,
  }
}

export function describeQuestion(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const question = str(input.question) ?? "a question"
  const options = strings(input.options)
  return {
    family: "question",
    verb: "Asked",
    target: { text: firstLine(question, 100), title: question },
    chips: [],
    bodies: [
      { type: "text", text: question },
      ...(options.length ? [{ type: "list" as const, label: "Options", items: options }] : []),
    ],
    failed: false,
  }
}

export function describeFinish(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const summary = textOf(input.summary)
  const harness = harnessResult(source.output)
  return {
    family: "finish",
    verb: source.running ? "Wrapping up" : "Wrapped up",
    target: { text: "the task" },
    chips: input.verified === true ? [{ label: "Verified", tone: "success" }] : [],
    bodies: withError(harness, summary ? [{ type: "text", text: summary.text, truncated: summary.truncated }] : []),
    failed: Boolean(harness?.failed),
  }
}

export function describeSpecialist(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const task = textOf(input.task)
  const context = textOf(input.context)
  const output = record(source.output)
  const answer =
    textOf(output.response) ??
    textOf(output.answer) ??
    textOf(output.result) ??
    textOf(output.summary) ??
    textOf(output.text) ??
    textOf(record(output.output).text) ??
    textOf(source.output)
  const name = source.agentName ?? (str(input.specialist) ? humanize(str(input.specialist)!) : "a specialist")
  return {
    family: "agent",
    verb: source.running ? "Consulting" : "Consulted",
    target: { text: name },
    chips: task ? [{ label: firstLine(task.text, 60), title: task.text }] : [],
    bodies: [
      ...(task ? [{ type: "text" as const, label: "Asked", text: task.text, truncated: task.truncated }] : []),
      ...(context ? [{ type: "text" as const, label: "Context", text: context.text, truncated: context.truncated }] : []),
      ...(answer ? [{ type: "text" as const, label: "Answer", text: answer.text, truncated: answer.truncated }] : []),
    ],
    failed: output.isError === true,
  }
}

export function describePreview(source: ToolCallSource): ToolCallView {
  const output = record(source.output)
  const logs = source.toolName === "get_preview_container_logs"
  const repair = source.toolName === "repair_preview_initialization"
  const outcome = str(output.outcome) ?? str(output.status) ?? str(output.state)
  const failed = output.isError === true || outcome === "failed"
  const logText =
    textOf(record(output.output).logs) ??
    textOf(output.logs) ??
    textOf(record(output.output).stdout) ??
    textOf(output.stdout)
  const fields = Object.entries(output)
    .filter(([key, value]) => !["output", "logs", "_meta", "isError"].includes(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .slice(0, 8)
    .map(([key, value]) => ({ label: humanize(key), value: String(value) }))
  return {
    family: "preview",
    verb: repair ? (source.running ? "Repairing" : "Repaired") : logs ? (source.running ? "Reading" : "Read") : source.running ? "Checking" : "Checked",
    target: { text: repair ? "the preview setup" : logs ? "preview logs" : "the preview" },
    chips: outcome ? [{ label: humanize(outcome), tone: failed ? "danger" : outcome === "ready" || outcome === "running" ? "success" : "neutral" }] : [],
    bodies: [
      ...(fields.length ? [{ type: "fields" as const, fields }] : []),
      ...(logText ? [{ type: "terminal" as const, output: stripAnsi(logText.text), truncated: logText.truncated }] : []),
    ],
    failed,
  }
}

const graphVerbs: Record<string, [string, string, string]> = {
  get_code_minimal_context: ["Gathering", "Gathered", "code context"],
  get_code_review_context: ["Gathering", "Gathered", "review context"],
  get_code_impact_radius: ["Measuring", "Measured", "the impact of the change"],
  get_code_architecture_overview: ["Mapping", "Mapped", "the architecture"],
  get_code_graph_status: ["Checking", "Checked", "the code graph"],
  update_code_graph: ["Updating", "Updated", "the code graph"],
}

export function describeGraph(source: ToolCallSource): ToolCallView {
  const [running, done, target] = graphVerbs[source.toolName ?? ""] ?? ["Using", "Used", "the code graph"]
  return {
    family: "graph",
    verb: source.running ? running : done,
    target: { text: target },
    chips: [],
    bodies: genericBodies(source),
    failed: record(source.output).isError === true,
  }
}

export function describeOther(source: ToolCallSource): ToolCallView {
  const name = source.toolName ? humanize(source.toolName) : source.title
  const input = record(source.input)
  const subject = Object.values(input).find((value): value is string => typeof value === "string" && value.trim().length > 0)
  const harness = harnessResult(source.output)
  const results = operationResults(source.output)
  return {
    family: "other",
    verb: name,
    target: subject ? { text: firstLine(subject, 80), mono: false, title: subject } : undefined,
    chips: [],
    bodies: withError(harness, genericBodies(source)),
    failed: Boolean(harness?.failed) || results.some((result) => result.success === false),
  }
}

function genericBodies(source: ToolCallSource): ToolCallBody[] {
  const bodies: ToolCallBody[] = []
  const fields = scalarFields(record(source.input))
  if (fields.length) bodies.push({ type: "fields", fields })
  const results = operationResults(source.output)
  if (results.length) {
    for (const result of results) {
      if (result.result) bodies.push({ type: "text", label: result.query, text: result.result.text, truncated: result.result.truncated })
    }
    return bodies
  }
  const text = textOf(source.output)
  if (text) {
    bodies.push({ type: "text", text: text.text, truncated: text.truncated })
    return bodies
  }
  const data = harnessResult(source.output)?.data ?? record(source.output)
  const outputFields = scalarFields(data)
  if (outputFields.length) bodies.push({ type: "fields", fields: outputFields })
  return bodies
}

function scalarFields(value: Record<string, unknown>) {
  return Object.entries(value).flatMap(([key, entry]) => {
    const text = typeof entry === "number" || typeof entry === "boolean" ? String(entry) : textOf(entry)?.text
    if (!text || key.endsWith("_ref") || key === "_meta") return []
    return [{ label: humanize(key), value: text.length > 600 ? `${text.slice(0, 600)}…` : text, mono: text.length < 120 && !/\s/u.test(text) }]
  }).slice(0, 10)
}

function commandOutput(data: Record<string, unknown>, update: unknown) {
  const text = textOf(data.output) ?? textOf(data.stdout) ?? textOf(record(update).output) ?? textOf(update)
  return text ? { text: stripAnsi(text.text), truncated: text.truncated } : undefined
}

function terminal(
  command: string | undefined,
  output: { text: string; truncated: boolean } | undefined,
  exitCode: number | undefined,
  cwd?: string
): ToolCallBody[] {
  // A command without output adds nothing to the row that already names it.
  if (!output) return []
  return [{ type: "terminal", command, cwd, output: output?.text, exitCode, truncated: output?.truncated }]
}

function statusChips(
  harness: ReturnType<typeof harnessResult>,
  exitCode: number | undefined,
  duration: string | undefined
): ToolCallChip[] {
  const chips: ToolCallChip[] = []
  if (harness?.failed) {
    const code = harness.message?.match(/exited with code (\d+)/iu)?.[1]
    chips.push({ label: code ? `Exit ${code}` : "Failed", tone: "danger" })
  } else if (exitCode !== undefined) {
    chips.push(exitCode === 0 ? { label: "Done", tone: "success" } : { label: `Exit ${exitCode}`, tone: "danger" })
  }
  if (duration) chips.push({ label: duration })
  return chips
}

function testCounts(counts: Record<string, unknown>): TestCounts | undefined {
  const passed = num(counts.passed)
  const failed = num(counts.failed)
  const skipped = num(counts.skipped)
  const total = num(counts.executed) ?? num(counts.total)
  if ([passed, failed, skipped, total].every((value) => value === undefined)) return undefined
  return { passed, failed, skipped, total }
}

function countChips(counts: TestCounts): ToolCallChip[] {
  const chips: ToolCallChip[] = []
  if (counts.failed) chips.push({ label: `${counts.failed} failed`, tone: "danger" })
  if (counts.passed !== undefined) chips.push({ label: `${counts.passed} passed`, tone: counts.failed ? "neutral" : "success" })
  if (counts.skipped) chips.push({ label: `${counts.skipped} skipped`, tone: "warning" })
  return chips
}

function taskLabel(input: Record<string, unknown>) {
  const task = record(input.task)
  return str(input.task) ?? str(task.task_id) ?? ([str(task.kind), str(task.target)].filter(Boolean).join(" ") || undefined)
}
