import { humanize, list, record, str, strings } from "./tool-call-values.ts"
import type {
  ToolCallBody,
  ToolCallChip,
  ToolCallSource,
  ToolCallView,
} from "./tool-call-view.ts"

// Blame's self-repair tools (`blame_inspect`, `blame_configure`,
// `blame_repair`). A configure call waits for the person's approval, so its
// target line holds the exact command, URL or source it will use.

const areaTargets: Record<string, string> = {
  overview: "Blame's state",
  preview: "the preview",
  mcp: "MCP servers",
  skills: "skills",
  providers: "model providers",
  runtime: "the runtime",
  logs: "Blame's logs",
}

const statusTone = (status: string | undefined): ToolCallChip["tone"] =>
  status === "ok" ? "success" : status === "problem" ? "danger" : "neutral"

export function describeBlameInspect(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const output = record(source.output)
  const area = str(input.area) ?? "overview"
  const search = str(input.search)
  const candidate = str(input.source)
  const failed = str(output.outcome) === "failed"
  const bodies: ToolCallBody[] = []
  const chips: ToolCallChip[] = []
  if (area === "overview") {
    const areas = list(output.areas).map(record)
    if (str(output.summary))
      chips.push({
        label: str(output.summary)!,
        tone: areas.some((entry) => entry.status === "problem")
          ? "danger"
          : "success",
      })
    if (areas.length)
      bodies.push({
        type: "fields",
        fields: areas.map((entry) => ({
          label: humanize(str(entry.area) ?? ""),
          value: `${str(entry.status) ?? "unknown"}: ${str(entry.summary) ?? ""}`,
        })),
      })
  } else if (area === "logs") {
    const lines = strings(output.lines)
    if (lines.length)
      bodies.push({ type: "terminal", output: lines.join("\n") })
    chips.push({ label: str(output.source) ?? "app" })
  } else {
    const status = str(output.status)
    if (str(output.summary))
      chips.push({ label: str(output.summary)!, tone: statusTone(status) })
    const refused = str(output.refused)
    const checked = record(record(output).candidate)
    if (refused) bodies.push({ type: "error", message: refused })
    else if (str(checked.name))
      bodies.push({
        type: "fields",
        fields: [
          { label: "Skill", value: str(checked.name)! },
          { label: "About", value: str(checked.description) ?? "" },
          { label: "Files", value: String(list(checked.files).length) },
        ],
      })
  }
  if (str(output.next))
    bodies.push({ type: "text", label: "Next", text: str(output.next)! })
  return {
    family: "preview",
    verb: source.running ? "Checking" : "Checked",
    target: {
      text:
        area === "skills" && candidate
          ? `skill ${candidate}`
          : `${areaTargets[area] ?? area}${search ? ` for "${search}"` : ""}`,
      ...(candidate ? { mono: true } : {}),
    },
    chips,
    bodies,
    failed,
  }
}

export function describeBlameConfigure(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const output = record(source.output)
  const action = str(input.action)
  const name = str(input.name)
  const running = source.running
  const command = [str(input.command), ...strings(input.args)]
    .filter(Boolean)
    .join(" ")
  const failed = str(output.outcome) === "failed" || Boolean(str(output.error))
  const next = str(output.next)
  const tail: ToolCallBody[] = [
    ...(str(output.error)
      ? [{ type: "error" as const, message: str(output.error)! }]
      : []),
    ...(next ? [{ type: "text" as const, label: "Next", text: next }] : []),
  ]
  if (action === "add_mcp") {
    const env = strings(input.env)
    return {
      family: "command",
      verb: running ? "Adding MCP server" : "Added MCP server",
      target: {
        text: `${name ?? "?"}: ${command || str(input.url) || "?"}`,
        mono: true,
        title: command || str(input.url),
      },
      chips: env.length ? [{ label: "needs variables" }] : [],
      bodies: [
        {
          type: "fields",
          fields: [
            ...(command ? [{ label: "Runs", value: command, mono: true }] : []),
            ...(str(input.url)
              ? [{ label: "Connects to", value: str(input.url)!, mono: true }]
              : []),
            ...(env.length
              ? [{ label: "You fill in", value: env.join(", "), mono: true }]
              : []),
          ],
        },
        ...tail,
      ],
      failed,
    }
  }
  if (action === "install_skill") {
    const files = Number(output.files)
    return {
      family: "skill",
      verb: running ? "Installing skill" : "Installed skill",
      target: { text: str(input.source) ?? "a skill", mono: true },
      chips: str(output.installed)
        ? [{ label: str(output.installed)!, mono: true }]
        : [],
      bodies: [
        {
          type: "fields",
          fields: [
            { label: "Source", value: str(input.source) ?? "", mono: true },
            {
              label: "For",
              value:
                input.scope === "project"
                  ? "this project (.claude/skills)"
                  : "all your projects (~/.agents/skills)",
            },
            ...(Number.isFinite(files)
              ? [{ label: "Files", value: String(files) }]
              : []),
            ...(str(output.path)
              ? [{ label: "Where", value: str(output.path)!, mono: true }]
              : []),
          ],
        },
        ...(strings(output.scripts).length
          ? [
              {
                type: "list" as const,
                label: "Scripts, copied and never run",
                items: strings(output.scripts),
              },
            ]
          : []),
        ...tail,
      ],
      failed,
    }
  }
  const verbs: Record<string, [string, string]> = {
    remove_mcp: ["Removing MCP server", "Removed MCP server"],
    set_mcp_enabled: [
      input.enabled === false
        ? "Turning off MCP server"
        : "Turning on MCP server",
      input.enabled === false
        ? "Turned off MCP server"
        : "Turned on MCP server",
    ],
  }
  const [present, past] = verbs[action ?? ""] ?? ["Configuring", "Configured"]
  return {
    family: "command",
    verb: running ? present : past,
    target: { text: name ?? "Blame", mono: Boolean(name) },
    chips: [],
    bodies: tail,
    failed,
  }
}

const repairTargets: Record<string, [string, string, string]> = {
  restart_preview: ["Restarting", "Restarted", "the preview"],
  refresh_dependencies: [
    "Reinstalling",
    "Reinstalled",
    "the preview's dependencies",
  ],
  start_runtime: ["Starting", "Started", "the runtime"],
  reconnect_mcp: ["Reconnecting", "Reconnected", "MCP server"],
}

export function describeBlameRepair(source: ToolCallSource): ToolCallView {
  const input = record(source.input)
  const output = record(source.output)
  const action = str(input.action) ?? ""
  const next = str(output.next)
  if (action === "hand_over") {
    const section = str(input.where)
    return {
      family: "question",
      verb: source.running ? "Asking you to" : "Asked you to",
      target: { text: str(input.why) ?? "take a step" },
      chips: str(output.where) ? [{ label: str(output.where)! }] : [],
      bodies: [
        ...(section ? [{ type: "settings-link" as const, section }] : []),
        ...(str(output.error)
          ? [{ type: "error" as const, message: str(output.error)! }]
          : []),
      ],
      failed: false,
    }
  }
  const [present, past, noun] = repairTargets[action] ?? [
    "Repairing",
    "Repaired",
    "Blame",
  ]
  const outcome = str(output.outcome)
  const before = record(output.before)
  const after = record(output.after)
  const states = (state: Record<string, unknown>) =>
    str(state.status) ?? str(state.state)
  const logExcerpt = strings(output.logExcerpt)
  return {
    family: "preview",
    verb: source.running ? present : past,
    target: {
      text:
        action === "reconnect_mcp"
          ? `${noun} ${str(input.name) ?? ""}`.trim()
          : noun,
    },
    chips: outcome
      ? [
          {
            label: humanize(outcome),
            tone:
              outcome === "fixed" || outcome === "already_running"
                ? "success"
                : "danger",
          },
        ]
      : [],
    bodies: [
      ...(states(before) || states(after)
        ? [
            {
              type: "fields" as const,
              fields: [
                ...(states(before)
                  ? [{ label: "Before", value: states(before)! }]
                  : []),
                ...(states(after)
                  ? [{ label: "After", value: states(after)! }]
                  : []),
                ...(str(output.cause)
                  ? [{ label: "Cause", value: str(output.cause)! }]
                  : []),
              ],
            },
          ]
        : []),
      ...(logExcerpt.length
        ? [{ type: "terminal" as const, output: logExcerpt.join("\n") }]
        : []),
      ...(str(output.error)
        ? [{ type: "error" as const, message: str(output.error)! }]
        : []),
      ...(next ? [{ type: "text" as const, label: "Next", text: next }] : []),
    ],
    failed: str(output.outcome) === "failed" || Boolean(str(output.error)),
  }
}
