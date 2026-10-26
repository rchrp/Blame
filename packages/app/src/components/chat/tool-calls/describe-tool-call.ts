import { describeEdit, describeRead, describeSearch } from "./describe-code.ts"
import { describeWebResearch } from "./describe-web-research.ts"
import {
  describeCommand,
  describeFinish,
  describeGraph,
  describeOther,
  describePreview,
  describeQuestion,
  describeSkill,
  describeSpecialist,
  describeWeb,
} from "./describe-run.ts"
import {
  describeComponentPreview,
  describePreviewDevtools,
  isPreviewDevtoolsTool,
} from "./describe-preview-devtools.ts"
import {
  describeStoryRead,
  describeStorySearch,
} from "./describe-story-history.ts"
import { num, record, str, textOf } from "./tool-call-values.ts"
import type { ToolCallSource, ToolCallView } from "./tool-call-view.ts"

export type ToolCallActivity = {
  kind: string
  title: string
  detail: string
  toolName?: string
  agentName?: string
}

const describers: Record<string, (source: ToolCallSource) => ToolCallView> = {
  read_code: describeRead,
  read_files: describeRead,
  inspect_code: describeRead,
  outline_code: describeRead,
  search_code: describeSearch,
  search_codebase: describeSearch,
  get_relation_context: describeSearch,
  edit_code: describeEdit,
  apply_patch: describeEdit,
  editor: describeEdit,
  write_file: describeEdit,
  apply_change: describeEdit,
  review_change: describeEdit,
  run_task: describeCommand,
  run_commands: describeCommand,
  inspect_run: describeCommand,
  validate_change: describeCommand,
  fetch_web_content: describeWeb,
  search_web: describeWebResearch,
  read_web_page: describeWebResearch,
  skills: describeSkill,
  ask_question: describeQuestion,
  ask_followup_question: describeQuestion,
  finish_task: describeFinish,
  submit_and_exit: describeFinish,
  attempt_completion: describeFinish,
  search_user_stories: describeStorySearch,
  read_user_story: describeStoryRead,
  consult_specialist: describeSpecialist,
  spawn_agent: describeSpecialist,
  get_preview_devtools: describePreview,
  open_component_preview: describeComponentPreview,
  get_preview_container_logs: describePreview,
  repair_preview_initialization: describePreview,
  get_code_minimal_context: describeGraph,
  get_code_review_context: describeGraph,
  get_code_impact_radius: describeGraph,
  get_code_architecture_overview: describeGraph,
  get_code_graph_status: describeGraph,
  update_code_graph: describeGraph,
}

// Reads a tool activity as stored in the conversation. The detail is the
// JSON written by the agent flow: { toolName, input, output, update, durationMs }.
export function toolCallSource(
  activity: ToolCallActivity,
  running: boolean
): ToolCallSource {
  const parsed = parseDetail(activity.detail)
  const raw = record(parsed.raw)
  const toolName =
    str(parsed.toolName) ??
    str(raw.toolName) ??
    str(record(raw.toolCall).name) ??
    activity.toolName ??
    toolNameFromTitle(activity.title)
  return {
    toolName,
    input: parsed.input,
    output: parsed.output,
    update: parsed.update,
    running,
    durationMs: num(parsed.durationMs),
    agentName: activity.agentName,
    title: activity.title,
    kind: activity.kind,
    detail: activity.detail,
  }
}

export function describeToolCall(source: ToolCallSource): ToolCallView {
  if (source.kind !== "tool") {
    const text = textOf(source.detail)
    const isJson = source.detail.trim().startsWith("{")
    return {
      family: "other",
      verb: source.title,
      chips: [],
      bodies:
        text && !isJson && text.text !== source.title
          ? [{ type: "text", text: text.text }]
          : [],
      failed: false,
    }
  }
  const describe =
    describers[source.toolName ?? ""] ??
    (isPreviewDevtoolsTool(source.toolName)
      ? describePreviewDevtools
      : describeOther)
  try {
    return describe(source)
  } catch {
    // A payload this view does not understand should never break the
    // conversation: fall back to the generic presentation.
    return describeOther(source)
  }
}

function parseDetail(detail: string): Record<string, unknown> {
  try {
    return record(JSON.parse(detail))
  } catch {
    return {}
  }
}

function toolNameFromTitle(title: string) {
  return title.match(
    /(?:Tool (?:finished|started|updated|used): )?([\w-]+)$/u
  )?.[1]
}
