import { createTool, type AgentTool, type AgentToolContext } from "@cline/sdk";
import { z } from "zod";
import { redactSecurityValue } from "../security-secret-redaction.js";
import type { PreviewDependencyRefreshResult } from "../preview-harness-tools.js";
import {
  lightEditCodeInputSchema,
  lightReadCodeInputSchema,
  lightDefaultRunTaskInputSchema,
  lightRunTaskInputSchema,
  lightSearchCodeInputSchema,
  type LightToolResult,
  type LightTaskContract,
} from "./light-contracts.js";
import type {
  LightToolContext,
  LightWorkspaceExecutor,
  LightWorkspaceToolName,
} from "./light-executor.js";
import { lightToolContext } from "./light-executor.js";
import { LightWorkspace } from "./light-workspace.js";
import { feedbackEnvelope } from "../tool-result-envelope.js";

export const lightReadToolNames = ["search_code", "read_code"] as const;
export const lightWriteToolNames = ["edit_code", "run_task"] as const;

export type LightHarnessToolsOptions = {
  executor?: LightWorkspaceExecutor;
  refreshPreviewDependencies?: () => Promise<PreviewDependencyRefreshResult>;
  taskContract?: LightTaskContract;
};

export function lightSemanticHarnessTools(
  workspaceRoot?: string,
  options: LightHarnessToolsOptions = {},
): AgentTool[] {
  if (!workspaceRoot) return [];
  const workspace = options.executor
    ? executorWorkspace(workspaceRoot, options)
    : new LightWorkspace(workspaceRoot, {
        refreshPreviewDependencies: options.refreshPreviewDependencies,
        sessionId: options.taskContract?.session_id ?? "unscoped-session",
        taskContract: options.taskContract,
      });
  return lightWorkspaceTools(workspace, options.taskContract?.environment);
}

type LightWorkspacePort = Pick<
  LightWorkspace,
  "editCode" | "readCode" | "runTask" | "searchCode"
>;

function executorWorkspace(
  workspaceRoot: string,
  options: LightHarnessToolsOptions,
): LightWorkspacePort {
  const invoke = executorInvocation(workspaceRoot, options);
  return {
    editCode: (input, context) =>
      invoke("edit_code", input, lightToolContext(context), context?.signal),
    readCode: (input, context) =>
      invoke("read_code", input, lightToolContext(context), context.signal),
    runTask: (input, context) =>
      invoke("run_task", input, lightToolContext(context), context.signal),
    searchCode: (input, signal) => invoke("search_code", input, {}, signal),
  };
}

function executorInvocation(
  workspaceRoot: string,
  options: LightHarnessToolsOptions,
) {
  return (
    tool: LightWorkspaceToolName,
    input: unknown,
    context: LightToolContext = {},
    signal?: AbortSignal,
  ) =>
    options.executor!(
      {
        input,
        taskContract: options.taskContract,
        tool,
        toolContext: context,
        workspaceRoot,
      },
      signal,
    );
}

function lightWorkspaceTools(workspace: LightWorkspacePort, environment?: LightTaskContract["environment"]) {
  return [
    searchCodeTool(workspace),
    readCodeTool(workspace),
    editCodeTool(workspace),
    runTaskTool(workspace, environment),
  ];
}

function searchCodeTool(workspace: LightWorkspacePort) {
  return harnessTool({
    name: "search_code",
    description:
      "The workspace grep, ripgrep-backed: use it instead of grep, rg or find in run_task. Find source by path, text, regex, symbol, or references. " +
      "text: whitespace-separated terms match any term, punctuation stays literal, and files containing more terms rank first. regex: one ripgrep regex such as foo|bar or \\bLineSelection\\b. auto picks symbol for a bare identifier. " +
      "For JS/TS semantic references, set mode to references and query to a symbol sN alias or path#qualifiedName; results state compiler project scope and any lexical fallback. Bare-name fallback proposes nextSearches; choose the intended declaration. " +
      "output files lists every matching file with its matching-line count; count returns totals. context adds surrounding lines to text matches. A match inside a declaration returns that declaration's sN alias with matchLine. " +
      "Results come in pages (8 matches or 50 files by default); a limited result carries nextSearch. Case is ignored unless caseSensitive. Search results do not authorize edits: read the target first. " +
      'Scope accepts paths and *, **, ?, or {a,b} globs; multiple scopes use an array such as ["src","spec"]. Spaces in a scope string are literal. Generated outputs and node_modules are excluded.',
    schema: lightSearchCodeInputSchema,
    normalize: searchCodeInput,
    execute: (input, context) => workspace.searchCode(input, context.signal),
  });
}

function readCodeTool(workspace: LightWorkspacePort) {
  return harnessTool({
    name: "read_code",
    description:
      "Read a text file or local image, compact directory, sN alias, path#qualifiedName, @changes, @checks, or @capabilities. @checks lists current-source check observations without running them; unknown counts stay null. A line range selects those lines; otherwise omit view for automatic raw/outline routing. Truncated reads propose nextRead and outline routes without granting unseen coverage. Use view signature on a symbol to inspect its declaration header without its body; read the symbol body before behavioral edits or rename. Symbol outlines list contained declarations. Results state the lines they hold and expose editTargets and containedBy relationships. Generated outputs and ordinary node_modules reads are excluded. For installed dependency types, use view declaration with localFile#importBinding or localFile#importBinding.exportedMember: the configured JS/TS compiler resolves a bounded read-only declaration with package/version identity. This grants no edit coverage and does not establish dependency runtime behavior; follow nextRead for continuation.",
    schema: lightReadCodeInputSchema,
    execute: (input, context) => workspace.readCode(input, context),
  });
}

function editCodeTool(workspace: LightWorkspacePort) {
  return harnessTool({
    name: "edit_code",
    description:
      'Atomically apply symbol operations or focused Cline patches. Each operation uses kind "symbol" or "patch"; symbol edits put the edit action in action. Example: {"operations":[{"kind":"symbol","target":"s1","action":"replace_body","content":"return 2;"}]}. For configured JS/TS, action "rename" with content containing only the new identifier computes related edits via the compiler, preserving existing aliases; first read the complete target declaration. Rename must be the sole operation in a batch; unavailable/incomplete projects or name capture are blocked. Its static guard is not test evidence; run required checks after editing. Set patch target to an observed sN alias to restrict one Update File to that symbol; the header must match its file. Choose the smaller precise edit: replace_body replaces the entire observed body. For a brace-delimited body, unbraced content inherits existing indentation; one-line content becomes inline. Include the outer braces to preserve explicit layout, or use a file patch. For a new file, patch may contain complete raw text; existing files require Cline patch syntax. Do not combine a parent with its containedBy child. The runtime handles freshness, overlaps, and supported syntax checks.',
    schema: lightEditCodeInputSchema,
    execute: (input, context) =>
      workspace.editCode(input, {
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        signal: context.signal,
      }),
  });
}

function runTaskTool(workspace: LightWorkspacePort, environment?: LightTaskContract["environment"]) {
  const reasoningEnabled = process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS === "true";
  return harnessTool({
    name: "run_task",
    description:
      "Run project tasks, validations, generators, formatters, or requested setup. Source inspection belongs to search_code and read_code; simple grep, rg, cat, head, tail and sed -n commands are answered by them. A command still running after the initial wait returns a session-bound rN id: kind inspect with that id waits until it ends (up to 5 minutes) and returns its result; with until set to output it returns at the next output instead. You can read and search code meanwhile. Output comes in pages: follow nextOutput, or fullOutput when a finished command's output was cut. Source changes are journaled and require a subsequent check. Explicit calls execute; finish_task reuses fresh validation. Use the dependency operation for Node packages and native commands for other ecosystems. " +
      (environment?.managedPreview === false
        ? "For requested services, detach the process and redirect its input/output so the command can finish. "
        : "Use the managed preview for services. ") +
      "Prettier on explicit files uses atomic edits. Test results include reporting counters; null is unknown and pending is distinct from skipped. Returns bounded output and code/environment diagnostics." +
      (reasoningEnabled ? ' Optional kind analyze uses a local Z3 executable (BLAME_Z3_PATH or z3) to search for counterexamples in a pure typed TypeScript scalar function: target is sN or path#functionName, inputs maps each parameter to {min,max} safe-integer bounds or {type:"boolean"}, assertion is a boolean expression over inputs and result. Unsupported constructs or unavailable solver return unknown. Example: {"kind":"analyze","target":"src/math.ts#difference","inputs":{"a":{"min":0,"max":100},"b":{"min":0,"max":100}},"assertion":"result === a - b"}. Bounded absence of counterexamples is not project verification; reproduce witnesses with real tests.' : ""),
    schema: reasoningEnabled ? lightRunTaskInputSchema : lightDefaultRunTaskInputSchema,
    normalize: runTaskInput,
    execute: (input, context) => workspace.runTask(input, context),
  });
}

/** A scope sent as a JSON array in a string, which no real path looks like. */
function searchCodeInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const scope = (value as Record<string, unknown>).scope;
  if (typeof scope !== "string" || !/^\s*\[[\s\S]*\]\s*$/u.test(scope)) return value;
  const parsed = jsonValue(scope);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ? { ...value, scope: parsed }
    : value;
}

/**
 * Known misreadings of run_task's shape: `kind: "inspect"` with a command
 * (it only polls a run), `kind: "task"` or a bare `task` for a project task,
 * and a run id without its `r` or holding a command.
 */
function runTaskInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input: Record<string, unknown> = { ...value };
  if (typeof input.task === "string" && (input.kind === "task" || (input.kind === undefined && input.command === undefined)))
    return { ...input, kind: "project" };
  if (input.kind !== "inspect") return value;
  const run = typeof input.run === "string" ? input.run.trim() : undefined;
  if (run && /^[rR]?[1-9]\d*$/u.test(run)) return { ...input, run: `r${run.replace(/^[rR]/u, "")}` };
  const command = typeof input.command === "string" ? input.command : run && /\s/u.test(run) ? run : undefined;
  if (!command || (input.run !== undefined && command !== run)) return value;
  delete input.cursor;
  delete input.run;
  return { ...input, kind: "command", command };
}

type ToolDefinition<TSchema extends z.ZodTypeAny> = {
  description: string;
  execute(
    input: z.infer<TSchema>,
    context: AgentToolContext,
  ): Promise<LightToolResult<unknown>>;
  name: string;
  /** Repairs a known model misreading before validation. */
  normalize?: (value: unknown) => unknown;
  schema: TSchema;
};

function harnessTool<TSchema extends z.ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): AgentTool {
  return createTool({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.schema as unknown as Record<string, unknown>,
    retryable: false,
    maxRetries: 0,
    async execute(value: unknown, context: AgentToolContext) {
      const parsed = parseLeniently(definition.schema, definition.normalize ? definition.normalize(value) : value);
      if (!parsed.success) return invalidInput(parsed.error);
      const response = modelToolResponse(await definition.execute(parsed.data, context));
      return definition.name === "run_task" ? feedbackEnvelope(response) : response;
    },
  });
}

/**
 * Models sometimes send a number, an object or an array as a JSON string
 * (`"limit": "100"`, `"range": "{\"startLine\":1}"`). Where the schema
 * rejected a string that parses as what it expected, use the parsed value.
 */
export function parseLeniently<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown) {
  let current = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return parsed;
    const repaired = withParsedStrings(current, parsed.error.issues);
    if (repaired === undefined) return parsed;
    current = repaired;
  }
  return schema.safeParse(current);
}

function withParsedStrings(value: unknown, issues: z.core.$ZodIssue[]) {
  const copy = structuredClone(value);
  let changed = false;
  for (const issue of issues) {
    if (issue.code !== "invalid_type" || !["array", "boolean", "number", "object"].includes(issue.expected)) continue;
    const key = issue.path.at(-1);
    const parent = issue.path.slice(0, -1).reduce<unknown>(
      (node, part) => (node && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[part] : undefined),
      copy,
    );
    if (key === undefined || !parent || typeof parent !== "object") continue;
    const raw = (parent as Record<PropertyKey, unknown>)[key];
    if (typeof raw !== "string") continue;
    const parsed = jsonValue(raw.trim());
    const kind = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    if (kind !== issue.expected) continue;
    (parent as Record<PropertyKey, unknown>)[key] = parsed;
    changed = true;
  }
  return changed ? copy : undefined;
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function modelToolResponse(result: LightToolResult<unknown>) {
  if (result.status !== "ok" || !result.content) return redactSecurityValue(result);
  const { content, ...text } = result;
  return [{ type: "text" as const, text: JSON.stringify(redactSecurityValue(text)) }, ...content];
}

function invalidInput(error: z.ZodError): LightToolResult<unknown> {
  return {
    status: "blocked",
    category: "input",
    message: error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; "),
  };
}
