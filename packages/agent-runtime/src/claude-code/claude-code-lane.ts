import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeCodeArguments } from "./claude-code-cli.js";
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
  requestEffort,
  systemPromptForClaudeCode,
  toolResults,
  toolUseIds,
  userContent,
  userTextBesideToolResults,
  type AnthropicBlock,
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
  mcpBaseUrl: string;
  stateDirectory: string;
  onClose(lane: ClaudeCodeLane): void;
};

type LaneState = "streaming" | "awaiting-tools" | "idle" | "closed";

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
  private pendingToolUseIds: string[] = [];
  private turnTools = new Map<string, string>();
  private stopReason?: string;
  private readonly calls = new Map<string, (result: McpToolResult) => void>();
  private readonly results = new Map<string, McpToolResult>();
  private stdout = "";
  private stderr = "";
  private readonly options: LaneOptions;

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
        mcpUrl: `${options.mcpBaseUrl}/mcp/${this.id}/${this.secret}`,
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
    this.beginTurn(request, sink);
    this.writeUser(initialUserContent(request.messages));
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
    if (this.state !== "idle" && this.state !== "awaiting-tools") return false;
    if (request.messages.length !== this.expectedLength) return false;
    if (laneSignature(request) !== this.signature) return false;
    if (conversationRoot(request) !== this.root) return false;
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
    const wasAwaitingTools = this.state === "awaiting-tools";
    this.beginTurn(request, sink);
    const last = request.messages.at(-1)!;
    if (!wasAwaitingTools) {
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

  close(reason = "Claude Code session closed.") {
    if (this.state === "closed") return;
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
    this.turnTools.clear();
    this.stopReason = undefined;
  }

  private deliver(toolUseId: string, result: McpToolResult) {
    const resolve = this.calls.get(toolUseId);
    if (resolve) {
      this.calls.delete(toolUseId);
      resolve(result);
    } else this.results.set(toolUseId, result);
  }

  private writeUser(content: AnthropicBlock[]) {
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
    if (message.type === "stream_event" && isRecord(message.event))
      this.readStreamEvent(message.event as AnthropicBlock);
    else if (message.type === "system" && message.subtype === "init")
      this.checkInit(message);
    else if (message.type === "result") this.readResult(message);
  }

  private readStreamEvent(event: AnthropicBlock) {
    const sink = this.sink;
    if (!sink) {
      // Claude Code moved on without Blame (for example it rejected a tool
      // call itself). This conversation can no longer follow Cline's.
      if (event.type === "message_start")
        this.close("Claude Code continued without Blame's tool results.");
      return;
    }
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

  private checkInit(message: Record<string, unknown>) {
    const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const server = servers.find(
      (item) => isRecord(item) && item.name === bridgeMcpServerName,
    );
    if (this.tools.length && isRecord(server) && server.status !== "connected")
      this.close(`Claude Code could not reach Blame's tools (${String(server.status)}).`);
  }

  private readResult(message: Record<string, unknown>) {
    if (!this.sink) return;
    const failed = message.is_error === true || message.subtype !== "success";
    if (!failed) {
      if (this.sinkHasEvents) this.finishTurn();
      return;
    }
    const text =
      typeof message.result === "string" && message.result
        ? message.result
        : Array.isArray(message.errors)
          ? message.errors.map(String).join("\n")
          : `Claude Code failed (${String(message.subtype)}).`;
    const { status, type } = classifyClaudeCodeError(text);
    const sink = this.sink;
    this.sink = undefined;
    sink.fail(status, type, text);
    // A failed turn leaves Claude Code's context ahead of Cline's.
    this.close(text);
  }
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
