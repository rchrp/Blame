import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  claudeCodeEnvironment,
  findClaudeCodeExecutable,
} from "./claude-code-cli.js";
import {
  bridgeMac,
  bridgeToken,
  SharedClaudeCodeBridge,
  tokenPrefix,
  type ClaudeCodeBridgeHandle,
} from "./claude-code-bridge-client.js";
import { laneEventLog, type LaneLog } from "./claude-code-events.js";
import { ClaudeCodeLane, type BridgeSink } from "./claude-code-lane.js";
import {
  anthropicError,
  BridgeRequestError,
  collectMessage,
  isRecord,
  claudeCodeEfforts,
  parseMessagesRequest,
  sseFrame,
  type AnthropicBlock,
  type ClaudeCodeEffort,
  type MessagesRequest,
} from "./claude-code-protocol.js";

export type ClaudeCodeBridgeOptions = {
  env?: NodeJS.ProcessEnv;
  stateDirectory: string;
  /** Overrides for tests: silence before a stream counts as stalled, and the check period. */
  stallMs?: number;
  wakeStallMs?: number;
  watchIntervalMs?: number;
  /** The longest a lane's first message waits for Claude Code to list Blame's tools. */
  toolsWaitMs?: number;
};

const maxBodyBytes = 64 * 1024 * 1024;

/**
 * Where the bridge keeps its port, secret and lanes: the same for every
 * process of the app, so the agent workers and the engine host share one
 * bridge.
 */
export function claudeCodeStateDirectory() {
  return (
    process.env.BLAME_CLAUDE_CODE_STATE_DIR?.trim() ||
    join(tmpdir(), "blame-claude-code")
  );
}
// Each Claude Code process holds ~110-120 MB, whatever its context size
// (measured 2026-11-19, Claude Code 2.1, idle and after a 160k-token turn).
// Every agent worker shares one bridge, so these bound the whole app: three
// running stories with their subagents, and the last conversation of the
// stories under review.
const maxLanesPerToken = 6;
const maxLanes = 12;
// Claude Code caches prompts for an hour: a follow-up within it reuses the
// warm process and cache, where a new process replays the whole transcript.
const sessionIdleMs = 55 * 60 * 1_000;
const operationIdleMs = 60 * 1_000;
const awaitingToolsLaneMs = 2 * 60 * 60 * 1_000;
const keepAliveMs = 20_000;
// A silent stream is interrupted after this long, or sooner after a wake
// from sleep, when the connection it used is most likely gone.
const stallMs = 150_000;
const wakeStallMs = 20_000;
const watchIntervalMs = 5_000;
// The wall clock moving this much more than the monotonic one means sleep.
const sleepGapMs = 15_000;

/**
 * A loopback server that lets Cline use the user's own Claude Code login.
 * Cline talks to it as an Anthropic Messages endpoint; Claude Code reaches
 * Blame's tools through its MCP endpoint. The first agent worker to need it
 * hosts it; the others reach it through its saved port and secret.
 */
export class ClaudeCodeBridge implements ClaudeCodeBridgeHandle {
  readonly hosting = true;
  private readonly lanesByToken = new Map<string, ClaudeCodeLane[]>();
  private readonly lanesById = new Map<string, ClaudeCodeLane>();
  private readonly reaper: NodeJS.Timeout;
  private readonly watcher: NodeJS.Timeout;
  private lastWatch = { monotonic: performance.now(), wall: Date.now() };
  private readonly log: LaneLog;
  private readonly server: http.Server;
  private readonly secret: Buffer;
  private readonly options: ClaudeCodeBridgeOptions;
  /** Set once the server listens. */
  port = 0;

  private constructor(
    server: http.Server,
    secret: Buffer,
    options: ClaudeCodeBridgeOptions,
    log: LaneLog,
  ) {
    this.server = server;
    this.secret = secret;
    this.options = options;
    this.log = log;
    this.reaper = setInterval(() => this.reapLanes(), 30_000);
    this.reaper.unref();
    this.watcher = setInterval(
      () => this.watchLanes(),
      options.watchIntervalMs ?? watchIntervalMs,
    );
    this.watcher.unref();
  }

  /** The bridge another worker hosts, or a new one hosted here. */
  static async connect(
    options: ClaudeCodeBridgeOptions,
  ): Promise<ClaudeCodeBridgeHandle> {
    return (
      (await ClaudeCodeBridge.find(options.stateDirectory)) ??
      ClaudeCodeBridge.start(options)
    );
  }

  /** The bridge running in another worker, if one answers. */
  static async find(stateDirectory: string) {
    const state = readState(join(stateDirectory, "bridge.json"));
    if (!state.port || !state.secret) return undefined;
    const shared = new SharedClaudeCodeBridge(state.port, state.secret);
    return (await shared.reachable()) ? shared : undefined;
  }

  static async start(
    options: ClaudeCodeBridgeOptions,
  ): Promise<ClaudeCodeBridgeHandle> {
    const lanesDirectory = join(options.stateDirectory, "lanes");
    mkdirSync(lanesDirectory, { recursive: true, mode: 0o700 });
    const statePath = join(options.stateDirectory, "bridge.json");
    const state = readState(statePath);
    const secret = state.secret ?? randomBytes(32).toString("base64url");
    // The server exists before the bridge that answers its requests.
    const target: { bridge?: ClaudeCodeBridge } = {};
    const server = http.createServer((request, response) => {
      void target.bridge?.handle(request, response).catch((error) => {
        if (!response.headersSent)
          json(response, 500, anthropicError("api_error", String(error)));
        else response.end();
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 120_000;
    const bridge = new ClaudeCodeBridge(
      server,
      Buffer.from(secret),
      { ...options, stateDirectory: lanesDirectory },
      laneEventLog(join(options.stateDirectory, "bridge-events.log")),
    );
    target.bridge = bridge;
    let port = state.port ? await listen(server, state.port) : undefined;
    if (!port && state.port) {
      // Another worker started the bridge at the same time.
      const shared = new SharedClaudeCodeBridge(state.port, secret);
      if (await shared.reachable()) {
        await bridge.close();
        return shared;
      }
    }
    // The saved port is taken: any free one works, sessions get a new URL.
    port ??= (await listen(server, 0))!;
    bridge.port = port;
    writeFileSync(statePath, JSON.stringify({ port, secret }), { mode: 0o600 });
    return bridge;
  }

  /**
   * A stable API key for one conversation scope. Scopes starting with `op:`
   * are one-off operations whose Claude Code process closes soon after.
   */
  token(scope: string) {
    return bridgeToken(this.secret, scope);
  }

  /** The endpoint Cline calls; an effort picked in Blame rides in the path. */
  baseUrl(host: string, effort?: ClaudeCodeEffort) {
    const prefix = effort ? `/effort/${effort}` : "";
    return `http://${host}:${this.port}${prefix}/v1`;
  }

  /** Claude Code processes this bridge runs. */
  get lanes() {
    return this.lanesById.size;
  }

  async reachable() {
    return true;
  }

  /** Closes the Claude Code processes of conversations that ended for good. */
  async closeScopes(scopes: string[]) {
    for (const scope of scopes) this.closeToken(this.token(scope));
  }

  async close() {
    clearInterval(this.reaper);
    clearInterval(this.watcher);
    for (const lane of [...this.lanesById.values()]) lane.close("Blame closed.");
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", "http://bridge");
    if (url.pathname === "/health") return json(response, 200, { ok: true });
    if (url.pathname === "/bridge") return this.control(request, response);
    const messages = /^(?:\/effort\/([a-z]+))?\/v1\/messages$/.exec(url.pathname);
    if (messages && request.method === "POST")
      return this.messages(request, response, effortValue(messages[1]));
    const mcp = /^\/mcp\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (mcp) return this.mcp(request, response, mcp[1]!, mcp[2]!);
    json(response, 404, anthropicError("not_found_error", "Not found."));
  }

  private async messages(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    effort: ClaudeCodeEffort | undefined,
  ) {
    const token = requestToken(request);
    if (!token || !this.validToken(token))
      return json(
        response,
        401,
        anthropicError("authentication_error", "Invalid Claude Code bridge key."),
      );
    let parsed: MessagesRequest;
    try {
      parsed = { ...parseMessagesRequest(await readJson(request)), effort };
    } catch (error) {
      const failure =
        error instanceof BridgeRequestError
          ? error
          : new BridgeRequestError(String(error));
      return json(
        response,
        failure.status,
        anthropicError(failure.type, failure.message),
      );
    }
    const env = claudeCodeEnvironment(this.options.env);
    const executablePath = findClaudeCodeExecutable(env);
    if (!executablePath)
      return json(
        response,
        401,
        anthropicError(
          "authentication_error",
          "Claude Code is not installed on this computer. Install it, sign in, then try again.",
        ),
      );
    const sink = parsed.stream ? streamSink(response) : jsonSink(response);
    const lanes = (this.lanesByToken.get(token) ?? []).filter((lane) => !lane.closed);
    const lane = lanes.find((candidate) => candidate.accepts(parsed));
    let active: ClaudeCodeLane;
    if (lane) {
      lane.continue(parsed, sink);
      active = lane;
    } else {
      // An idle conversation of this scope that does not continue here is
      // over: a finished subagent, or history Cline rewrote.
      for (const old of lanes)
        if (old.idle) old.close("Superseded by a newer conversation of the same session.");
      active = new ClaudeCodeLane(parsed, sink, {
        env,
        executablePath,
        idleMs: tokenScope(token).startsWith("op:")
          ? operationIdleMs
          : sessionIdleMs,
        log: this.log,
        mcpBaseUrl: `http://127.0.0.1:${this.port}`,
        scope: tokenScope(token),
        stallMs: this.options.stallMs ?? stallMs,
        stateDirectory: this.options.stateDirectory,
        wakeStallMs: this.options.wakeStallMs ?? wakeStallMs,
        ...(this.options.toolsWaitMs !== undefined ? { toolsWaitMs: this.options.toolsWaitMs } : {}),
        onClose: (closed) => this.forget(token, closed),
      });
      this.lanesById.set(active.id, active);
      this.lanesByToken.set(token, [...lanes.filter((open) => !open.closed), active]);
      this.evict(token);
    }
    response.on("close", () => {
      if (!response.writableFinished) active.abandonTurn();
    });
  }

  private async mcp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    laneId: string,
    secret: string,
  ) {
    const lane = this.lanesById.get(laneId);
    if (!lane || lane.closed || !sameSecret(lane.secret, secret))
      return json(response, 404, { error: "Unknown session." });
    if (request.method === "DELETE") return json(response, 200, {});
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const body = await readJson(request);
    if (!isRecord(body) || body.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const params = isRecord(body.params) ? body.params : {};
    if (body.method === "tools/call") {
      const meta = isRecord(params._meta) ? params._meta : {};
      const toolUseId = meta["claudecode/toolUseId"];
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      const keepAlive = setInterval(() => response.write(": ping\n\n"), keepAliveMs);
      const result = await lane.callTool(
        String(params.name ?? ""),
        typeof toolUseId === "string" ? toolUseId : undefined,
      );
      clearInterval(keepAlive);
      response.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
      );
      return;
    }
    json(response, 200, { jsonrpc: "2.0", id: body.id, ...mcpResponse(body.method, params, lane) });
    if (body.method === "tools/list") lane.noteToolsListed();
  }

  /**
   * Another worker checks the bridge answers (GET), or closes the
   * conversations of one scope (DELETE), with that scope's key.
   */
  private control(request: http.IncomingMessage, response: http.ServerResponse) {
    const token = requestToken(request);
    if (!token || !this.validToken(token))
      return json(response, 401, anthropicError("authentication_error", "Invalid Claude Code bridge key."));
    if (request.method === "DELETE") this.closeToken(token);
    json(response, 200, { lanes: this.lanesById.size });
  }

  private closeToken(token: string) {
    for (const lane of this.lanesByToken.get(token) ?? [])
      lane.close("The session ended.");
  }

  private validToken(token: string) {
    const [prefix, encoded, mac, extra] = token.split(".");
    if (prefix !== tokenPrefix || !encoded || !mac || extra !== undefined)
      return false;
    return sameSecret(bridgeMac(this.secret, encoded), mac);
  }

  /** Closes the least useful processes: finished turns first, oldest first. */
  private evict(token: string) {
    const closeBeyond = (lanes: ClaudeCodeLane[], limit: number) => {
      const candidates = lanes
        .filter((lane) => !lane.busy)
        .sort(
          (left, right) =>
            Number(left.awaitingTools) - Number(right.awaitingTools) ||
            left.lastUsedAt - right.lastUsedAt,
        );
      let count = lanes.length;
      while (count > limit && candidates.length) {
        candidates.shift()!.close("Replaced by a newer Claude Code session.");
        count -= 1;
      }
    };
    closeBeyond(this.lanesByToken.get(token) ?? [], maxLanesPerToken);
    closeBeyond([...this.lanesById.values()], maxLanes);
  }

  private forget(token: string, lane: ClaudeCodeLane) {
    this.lanesById.delete(lane.id);
    const lanes = (this.lanesByToken.get(token) ?? []).filter((item) => item !== lane);
    if (lanes.length) this.lanesByToken.set(token, lanes);
    else this.lanesByToken.delete(token);
  }

  /** Notices a wake from sleep, then lets each lane check its stream. */
  private watchLanes() {
    const now = { monotonic: performance.now(), wall: Date.now() };
    const slept =
      now.wall - this.lastWatch.wall - (now.monotonic - this.lastWatch.monotonic);
    this.lastWatch = now;
    const lanes = [...this.lanesById.values()];
    if (slept > sleepGapMs) {
      this.log("system_woke", { lanes: lanes.length, sleptMs: Math.round(slept) });
      for (const lane of lanes) lane.noteWake(now.monotonic);
    }
    for (const lane of lanes) lane.watch(now.monotonic);
  }

  private reapLanes() {
    const now = Date.now();
    for (const lane of [...this.lanesById.values()]) {
      if (lane.busy) continue;
      const limit = lane.awaitingTools ? awaitingToolsLaneMs : lane.idleMs;
      if (now - lane.lastUsedAt > limit) lane.close("Claude Code session expired.");
    }
  }
}

function tokenScope(token: string) {
  return Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
}

function effortValue(value: string | undefined) {
  return claudeCodeEfforts.find((effort) => effort === value);
}

function mcpResponse(
  method: unknown,
  params: Record<string, unknown>,
  lane: ClaudeCodeLane,
) {
  if (method === "initialize")
    return {
      result: {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "blame", version: "1.0.0" },
      },
    };
  if (method === "ping") return { result: {} };
  if (method === "tools/list")
    return {
      result: {
        tools: lane.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.input_schema,
        })),
      },
    };
  return { error: { code: -32601, message: `Method not found: ${String(method)}` } };
}

function streamSink(response: http.ServerResponse): BridgeSink {
  let finished = false;
  const open = () => {
    if (response.headersSent) return;
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
  };
  return {
    event(event) {
      if (finished) return;
      open();
      response.write(sseFrame(event));
    },
    fail(status, type, message) {
      if (finished) return;
      finished = true;
      if (!response.headersSent)
        return json(response, status, anthropicError(type, message));
      response.end(sseFrame(anthropicError(type, message)));
    },
    done() {
      if (finished) return;
      finished = true;
      open();
      response.end();
    },
  };
}

function jsonSink(response: http.ServerResponse): BridgeSink {
  const events: AnthropicBlock[] = [];
  let finished = false;
  return {
    event(event) {
      events.push(event);
    },
    fail(status, type, message) {
      if (finished) return;
      finished = true;
      json(response, status, anthropicError(type, message));
    },
    done() {
      if (finished) return;
      finished = true;
      json(response, 200, collectMessage(events));
    },
  };
}

function requestToken(request: http.IncomingMessage) {
  const key = request.headers["x-api-key"];
  if (typeof key === "string" && key) return key.trim();
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return undefined;
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes)
      throw new BridgeRequestError("Request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BridgeRequestError("Request body is not valid JSON.");
  }
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return void response.end();
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function sameSecret(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readState(path: string): { port?: number; secret?: string } {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      port: typeof value.port === "number" ? value.port : undefined,
      secret: typeof value.secret === "string" ? value.secret : undefined,
    };
  } catch {
    return {};
  }
}

/** The port the server listens on, or undefined when that one is taken. */
function listen(server: http.Server, port: number) {
  return new Promise<number | undefined>((resolve) => {
    const onError = () => resolve(undefined);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
