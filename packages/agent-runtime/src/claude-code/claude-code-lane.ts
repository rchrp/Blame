import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { recordClaudeCodeRateLimit } from "../subscription-usage.js";
import { claudeCodeArguments } from "./claude-code-cli.js";
import type { LaneLog } from "./claude-code-events.js";
import {
  bridgeMcpServerName,
  bridgeToolName,
  classifyClaudeCodeError,
  clientStreamEvent,
  conversationRoot,
  initialUserContent,
  isRecord,
  laneSignature,
  mcpToolResult,
  messageBlocks,
  requestEffort,
  systemPromptForClaudeCode,
  toolResults,
  toolUseIds,
  userContent,
  userTextBesideToolResults,
  type AnthropicBlock,
  type AnthropicMessage,
  type AnthropicTool,
  type McpToolResult,
  type MessagesRequest,
} from "./claude-code-protocol.js";

/** Where one model turn is written: an HTTP response to Cline. */
export type BridgeSink = {
  event(event: AnthropicBlock): void;
  fail(status: number, type: string, message: string): void;
  done(): void;
};

export type LaneOptions = {
  env: NodeJS.ProcessEnv;
  executablePath: string;
  /** How long a finished turn keeps its process for a follow-up. */
  idleMs: number;
  log: LaneLog;
  mcpBaseUrl: string;
  /** The conversation the bridge key belongs to, for the event log. */
  scope: string;
  /** Silence after which a generating turn counts as stalled. */
  stallMs: number;
  stateDirectory: string;
  /** The same, counted from the moment the computer woke from sleep. */
  wakeStallMs: number;
  /** The longest the first message waits for Claude Code to list Blame's tools. */
  toolsWaitMs?: number;
  onClose(lane: ClaudeCodeLane): void;
};

/**
 * `cut`: Claude Code ended an answer without a stop reason (its connection
 * dropped, or Blame interrupted a silent stream). Cline got the partial
 * answer and will ask again; the process keeps the conversation meanwhile.
 */
type LaneState = "streaming" | "awaiting-tools" | "idle" | "cut" | "closed";

const interruptGraceMs = 15_000;
const toolsWaitMs = 20_000;
const maxRecoveries = 2;
const recoveryPrompt =
  "The connection to the model dropped. Continue from where you left off.";

/**
 * One Claude Code process serving one conversation. Claude Code only
 * generates: each tool call it makes is held open until Blame's harness sends
 * the result in its next request, so the model keeps a native context and
 * Blame keeps its tools, approvals and events.
 */
export class ClaudeCodeLane {
  readonly id = randomUUID();
  readonly secret = randomBytes(18).toString("base64url");
  readonly signature: string;
  readonly tools: AnthropicTool[];
  lastUsedAt = Date.now();
  private state: LaneState = "streaming";
  private readonly root: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly systemPromptFile: string;
  private sink?: BridgeSink;
  private sinkHasEvents = false;
  private expectedLength = 0;
  private requestLength = 0;
  private requestTail?: AnthropicMessage;
  private pendingToolUseIds: string[] = [];
  private turnTools = new Map<string, string>();
  private stopReason?: string;
  private readonly calls = new Map<string, (result: McpToolResult) => void>();
  private readonly results = new Map<string, McpToolResult>();
  /** Claude Code is inside one of its own turns: from a user message to its result. */
  private claudeTurnOpen = false;
  /** Events Claude Code streamed while the turn was cut and Cline had not asked again. */
  private held: AnthropicBlock[] = [];
  /** Cline's reminder, for when Claude Code gives up instead of retrying. */
  private awaitedReminder?: AnthropicBlock[];
  private lastOutputAt = performance.now();
  private wokeAt?: number;
  private retryDelayMs = 0;
  private interruptedAt?: number;
  private recoveries = 0;
  private turns = 0;
  private readonly startedAt = Date.now();
  private stdout = "";
  private stderr = "";
  private readonly options: LaneOptions;
  /** Resolves once Claude Code has listed Blame's tools over MCP. */
  private toolsListed!: () => void;
  private readonly toolsReady = new Promise<void>((resolve) => {
    this.toolsListed = resolve;
  });

  constructor(request: MessagesRequest, sink: BridgeSink, options: LaneOptions) {
    this.options = options;
    this.signature = laneSignature(request);
    this.root = conversationRoot(request);
    this.tools = request.tools ?? [];
    this.systemPromptFile = join(options.stateDirectory, `${this.id}.md`);
    writeFileSync(this.systemPromptFile, systemPromptForClaudeCode(request), {
      mode: 0o600,
    });
    this.child = spawn(
      options.executablePath,
      claudeCodeArguments({
        effort: requestEffort(request),
        mcpUrl: this.tools.length
          ? `${options.mcpBaseUrl}/mcp/${this.id}/${this.secret}`
          : undefined,
        model: request.model,
        systemPromptFile: this.systemPromptFile,
      }),
      { cwd: options.stateDirectory, env: options.env, windowsHide: true },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    this.child.on("error", (error) => this.close(error.message));
    this.child.on("exit", (code, signal) =>
      this.close(
        `Claude Code exited (${signal ?? code ?? "unknown"}). ${this.stderr.trim()}`.trim(),
      ),
    );
    this.child.stdin.on("error", () => undefined);
    options.log("lane_started", {
      lane: this.id,
      scope: options.scope,
      messages: request.messages.length,
      replayed: request.messages.length > 1,
      model: request.model,
    });
    this.beginTurn(request, sink);
    void this.writeFirstUser(initialUserContent(request.messages));
  }

  /** Claude Code listed Blame's tools: they exist for the model from now on. */
  noteToolsListed() {
    this.toolsListed();
  }

  /**
   * Claude Code starts its first turn without waiting for a slow MCP server:
   * the model then calls Blame's tools by their bare names and gets "No such
   * tool available", and the lane is lost (US-045, US-047). It lists the tools
   * about 0.3 s after starting, before any input, so the first message waits
   * for that, up to a bound.
   */
  private async writeFirstUser(content: AnthropicBlock[]) {
    if (this.tools.length) {
      const started = performance.now();
      let timer: NodeJS.Timeout | undefined;
      const listed = await Promise.race([
        this.toolsReady.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.options.toolsWaitMs ?? toolsWaitMs);
        }),
      ]);
      clearTimeout(timer);
      const waitedMs = Math.round(performance.now() - started);
      if (!listed || waitedMs > 1_000) this.log("tools_wait", { listed, waitedMs });
    }
    if (this.state === "closed") return;
    this.writeUser(content);
  }

  get idleMs() {
    return this.options.idleMs;
  }

  get closed() {
    return this.state === "closed";
  }

  get busy() {
    return this.state === "streaming";
  }

  get awaitingTools() {
    return this.state === "awaiting-tools";
  }

  /** True when the request is exactly the next turn of this conversation. */
  accepts(request: MessagesRequest) {
    if (laneSignature(request) !== this.signature) return false;
    if (conversationRoot(request) !== this.root) return false;
    if (this.state === "cut") return this.acceptsAfterCut(request.messages);
    if (this.state !== "idle" && this.state !== "awaiting-tools") return false;
    if (request.messages.length !== this.expectedLength) return false;
    const assistant = request.messages[this.expectedLength - 2];
    if (assistant?.role !== "assistant") return false;
    if (!sameIds(toolUseIds(assistant), this.pendingToolUseIds)) return false;
    const resultIds = toolResults(request.messages.at(-1)!).map((block) =>
      String(block.tool_use_id),
    );
    return this.state === "awaiting-tools"
      ? sameIds(resultIds, this.pendingToolUseIds)
      : resultIds.length === 0;
  }

  continue(request: MessagesRequest, sink: BridgeSink) {
    const previous = this.state;
    const reminder = previous === "cut" ? this.cutReminder(request.messages) : [];
    this.beginTurn(request, sink);
    const last = request.messages.at(-1)!;
    if (previous === "cut") return this.resumeAfterCut(reminder);
    if (previous !== "awaiting-tools") {
      this.writeUser(userContent(last));
      return;
    }
    const blocks = toolResults(last);
    const extraText = userTextBesideToolResults(last);
    blocks.forEach((block, index) =>
      this.deliver(
        String(block.tool_use_id),
        mcpToolResult(block, index === blocks.length - 1 ? extraText : undefined),
      ),
    );
  }

  /** An MCP tools/call from Claude Code; resolves once Blame sends the result. */
  callTool(name: string, toolUseId: string | undefined): Promise<McpToolResult> {
    this.lastUsedAt = Date.now();
    const id =
      toolUseId ??
      [...this.turnTools.entries()].find(
        ([candidate, toolName]) =>
          toolName === name && !this.calls.has(candidate),
      )?.[0];
    if (!id) return Promise.resolve(errorResult(`Unknown tool call ${name}.`));
    const ready = this.results.get(id);
    if (ready) {
      this.results.delete(id);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => this.calls.set(id, resolve));
  }

  /** The client went away mid-turn: the conversation state is unknown. */
  abandonTurn() {
    if (this.state === "streaming") this.close("The client closed the request.");
  }

  /** The computer woke from sleep: a stream that was open is likely dead. */
  noteWake(now: number) {
    this.wokeAt = now;
  }

  /**
   * Checked every few seconds. A dead connection does not always fail: after
   * sleep or a network change the stream can stay silent for many minutes.
   * Interrupting the turn keeps the process and its prompt cache; the turn is
   * then retried or continued like a dropped connection.
   */
  watch(now: number) {
    if (this.state === "closed") return;
    if (this.interruptedAt !== undefined) {
      if (now - this.interruptedAt > interruptGraceMs)
        this.close("Claude Code did not answer an interrupt of its silent stream.");
      return;
    }
    if (!this.claudeTurnOpen || this.calls.size) return;
    if (this.state !== "streaming" && this.state !== "cut") return;
    const afterWake = this.wokeAt !== undefined && this.wokeAt > this.lastOutputAt;
    const quietSince = afterWake ? this.wokeAt! : this.lastOutputAt;
    const limit =
      (afterWake ? this.options.wakeStallMs : this.options.stallMs) + this.retryDelayMs;
    if (now - quietSince < limit) return;
    this.interruptedAt = now;
    this.log("stream_interrupted", {
      afterWake,
      quietMs: Math.round(now - this.lastOutputAt),
      state: this.state,
    });
    this.child.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
    );
  }

  close(reason = "Claude Code session closed.") {
    if (this.state === "closed") return;
    this.log("lane_closed", {
      ageMs: Date.now() - this.startedAt,
      reason: reason.slice(0, 500),
      state: this.state,
      turns: this.turns,
    });
    this.state = "closed";
    this.sink?.fail(500, "api_error", reason);
    this.sink = undefined;
    for (const resolve of this.calls.values()) resolve(errorResult(reason));
    this.calls.clear();
    this.child.stdin.end();
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
      }, 3_000).unref();
    }
    rmSync(this.systemPromptFile, { force: true });
    this.options.onClose(this);
  }

  private beginTurn(request: MessagesRequest, sink: BridgeSink) {
    this.lastUsedAt = Date.now();
    this.state = "streaming";
    this.sink = sink;
    this.sinkHasEvents = false;
    this.requestLength = request.messages.length;
    this.requestTail = request.messages.at(-1);
    this.turnTools.clear();
    this.stopReason = undefined;
    this.recoveries = 0;
    this.awaitedReminder = undefined;
    this.turns += 1;
  }

  /**
   * After a cut, Cline either keeps the partial answer and adds a reminder
   * (two more messages) or resends the request with the reminder merged into
   * its last user turn.
   */
  private acceptsAfterCut(messages: AnthropicMessage[]) {
    const last = messages.at(-1)!;
    if (last.role !== "user") return false;
    if (messages.length === this.requestLength + 2) {
      const partial = messages[this.requestLength]!;
      return (
        partial.role === "assistant" &&
        toolUseIds(partial).length === 0 &&
        toolResults(last).length === 0
      );
    }
    return (
      messages.length === this.requestLength &&
      sameIds(resultIds(last), this.requestTail ? resultIds(this.requestTail) : [])
    );
  }

  /** What Cline added after the cut: its reminder, as a whole message or merged into the last one. */
  private cutReminder(messages: AnthropicMessage[]): AnthropicBlock[] {
    const last = messages.at(-1)!;
    if (messages.length !== this.requestLength) return userContent(last);
    const before = new Set(
      (this.requestTail ? messageBlocks(this.requestTail) : []).map((block) => JSON.stringify(block)),
    );
    return messageBlocks(last).filter(
      (block) => block.type === "text" && !before.has(JSON.stringify(block)),
    );
  }

  /** Relays what Claude Code regenerated meanwhile, or hands it Cline's reminder if it gave up. */
  private resumeAfterCut(reminder: AnthropicBlock[]) {
    const held = this.held;
    this.held = [];
    this.log("turn_resumed", { heldEvents: held.length, claudeTurnOpen: this.claudeTurnOpen });
    for (const event of held) if (this.state === "streaming") this.readStreamEvent(event);
    if (this.state !== "streaming" || this.sinkHasEvents) return;
    const next = reminder.length ? reminder : [{ type: "text", text: recoveryPrompt }];
    // Claude Code may still retry on its own; if it gives up, its result
    // line can arrive after Cline asked again (US-045, on a loaded VM).
    if (this.claudeTurnOpen) this.awaitedReminder = next;
    else this.writeUser(next);
  }

  private deliver(toolUseId: string, result: McpToolResult) {
    const resolve = this.calls.get(toolUseId);
    if (resolve) {
      this.calls.delete(toolUseId);
      resolve(result);
    } else this.results.set(toolUseId, result);
  }

  private writeUser(content: AnthropicBlock[]) {
    this.claudeTurnOpen = true;
    this.lastOutputAt = performance.now();
    this.child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
    );
  }

  private readStdout(chunk: string) {
    this.stdout += chunk;
    let index = this.stdout.indexOf("\n");
    while (index >= 0) {
      const line = this.stdout.slice(0, index).trim();
      this.stdout = this.stdout.slice(index + 1);
      if (line) this.readLine(line);
      index = this.stdout.indexOf("\n");
    }
  }

  private readLine(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || this.state === "closed") return;
    this.lastOutputAt = performance.now();
    if (message.type === "stream_event" && isRecord(message.event)) {
      this.retryDelayMs = 0;
      this.readStreamEvent(message.event as AnthropicBlock);
    } else if (message.type === "system" && message.subtype === "init")
      this.checkInit(message);
    else if (message.type === "system" && message.subtype === "api_retry")
      this.noteRetry(message);
    else if (message.type === "result") this.readResult(message);
    else if (message.type === "rate_limit_event")
      recordClaudeCodeRateLimit(message.rate_limit_info);
    else if (message.type === "user") this.noteToolErrors(message);
  }

  /**
   * Claude Code answered a tool call itself (a timeout, an input it
   * rejected): why, for when it then continues without Blame.
   */
  private noteToolErrors(message: Record<string, unknown>) {
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content)
      if (isRecord(block) && block.type === "tool_result" && block.is_error === true)
        this.log("tool_error", {
          error: blockText(block.content).slice(0, 500),
          toolUseId: block.tool_use_id,
        });
  }

  private readStreamEvent(event: AnthropicBlock) {
    if (this.state === "cut") {
      this.held.push(event);
      return;
    }
    const sink = this.sink;
    if (!sink) {
      // Claude Code moved on without Blame (for example it rejected a tool
      // call itself). This conversation can no longer follow Cline's.
      if (event.type === "message_start")
        this.close("Claude Code continued without Blame's tool results.");
      return;
    }
    if (event.type === "message_start") this.stopReason = undefined;
    if (
      event.type === "content_block_start" &&
      isRecord(event.content_block) &&
      event.content_block.type === "tool_use"
    )
      this.turnTools.set(
        String(event.content_block.id),
        bridgeToolName(String(event.content_block.name)),
      );
    if (event.type === "message_delta" && isRecord(event.delta))
      this.stopReason = String(event.delta.stop_reason ?? "") || undefined;
    if (event.type === "message_stop" && !this.stopReason) return this.cutTurn();
    this.sinkHasEvents = true;
    sink.event(clientStreamEvent(event));
    if (event.type === "message_stop") this.finishTurn();
  }

  private finishTurn() {
    const sink = this.sink;
    this.sink = undefined;
    this.lastUsedAt = Date.now();
    this.expectedLength = this.requestLength + 2;
    if (this.stopReason === "tool_use" && this.turnTools.size) {
      this.state = "awaiting-tools";
      this.pendingToolUseIds = [...this.turnTools.keys()];
    } else {
      this.state = "idle";
      this.pendingToolUseIds = [];
    }
    sink?.done();
  }

  /**
   * Claude Code closed an answer without a stop reason: its connection
   * dropped (it retries on its own) or Blame interrupted a silent stream.
   */
  private cutTurn() {
    const sink = this.sink!;
    this.sink = undefined;
    sink.event({ type: "message_stop" });
    sink.done();
    this.lastUsedAt = Date.now();
    // Cline may run the partial answer's tool calls; Claude Code will not.
    if (this.turnTools.size) {
      this.close("Claude Code's answer was cut during a tool call.");
      return;
    }
    this.state = "cut";
    this.held = [];
    this.log("turn_cut", { claudeTurnOpen: this.claudeTurnOpen });
  }

  private noteRetry(message: Record<string, unknown>) {
    this.retryDelayMs = Number(message.retry_delay_ms) || 0;
    this.log("api_retry", {
      attempt: message.attempt,
      delayMs: message.retry_delay_ms,
      error: message.error,
      errorStatus: message.error_status,
    });
  }

  private checkInit(message: Record<string, unknown>) {
    const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const server = servers.find(
      (item) => isRecord(item) && item.name === bridgeMcpServerName,
    );
    if (this.tools.length && isRecord(server) && server.status !== "connected")
      this.close(`Claude Code could not reach Blame's tools (${String(server.status)}).`);
  }

  private readResult(message: Record<string, unknown>) {
    const interrupted = this.interruptedAt !== undefined;
    this.interruptedAt = undefined;
    this.claudeTurnOpen = false;
    const failed = message.is_error === true || message.subtype !== "success";
    const text = failed ? resultText(message) : "";
    if (this.state === "cut") {
      // Only a whole regenerated answer can still be relayed.
      if (!completeAnswer(this.held)) this.held = [];
      if (failed) this.log("claude_turn_failed", { error: text.slice(0, 300) });
      return;
    }
    if (!this.sink) return;
    const reminder = this.awaitedReminder;
    this.awaitedReminder = undefined;
    if (failed && reminder && !this.sinkHasEvents) {
      this.writeUser(reminder);
      return;
    }
    if (!failed) {
      if (this.sinkHasEvents) this.finishTurn();
      return;
    }
    if (!this.sinkHasEvents && this.recoverable(text, interrupted)) {
      this.recoveries += 1;
      this.log("turn_retried", { attempt: this.recoveries, error: text.slice(0, 300) });
      this.writeUser([{ type: "text", text: recoveryPrompt }]);
      return;
    }
    const { status, type } = classifyClaudeCodeError(text);
    const sink = this.sink;
    this.sink = undefined;
    sink.fail(status, type, text);
    // A failed turn leaves Claude Code's context ahead of Cline's.
    this.close(text);
  }

  /** Nothing reached Cline yet, and the failure is a dropped or stalled connection. */
  private recoverable(text: string, interrupted: boolean) {
    if (this.recoveries >= maxRecoveries) return false;
    return interrupted || classifyClaudeCodeError(text).status >= 500;
  }

  private log(event: string, details: Record<string, unknown> = {}) {
    this.options.log(event, { lane: this.id, scope: this.options.scope, ...details });
  }
}

function resultText(message: Record<string, unknown>) {
  if (typeof message.result === "string" && message.result) return message.result;
  if (Array.isArray(message.errors)) return message.errors.map(String).join("\n");
  return `Claude Code failed (${String(message.subtype)}).`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : "")).join("\n");
}

function completeAnswer(events: AnthropicBlock[]) {
  return events.some(
    (event) =>
      event.type === "message_delta" &&
      isRecord(event.delta) &&
      Boolean(event.delta.stop_reason),
  );
}

function resultIds(message: AnthropicMessage) {
  return toolResults(message).map((block) => String(block.tool_use_id));
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
