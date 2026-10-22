import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import {
  claudeCodeEnvironment,
  findClaudeCodeExecutable,
} from "./claude-code-cli.js";
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
};

const maxBodyBytes = 64 * 1024 * 1024;
// Each Claude Code process holds a few hundred MB: keep few, close idle ones.
const maxLanesPerToken = 6;
const maxLanes = 12;
const sessionIdleMs = 10 * 60 * 1_000;
const operationIdleMs = 60 * 1_000;
const awaitingToolsLaneMs = 2 * 60 * 60 * 1_000;
const keepAliveMs = 20_000;
const tokenPrefix = "bcc1";

/**
 * A loopback server that lets Cline use the user's own Claude Code login.
 * Cline talks to it as an Anthropic Messages endpoint; Claude Code reaches
 * Blame's tools through its MCP endpoint.
 */
export class ClaudeCodeBridge {
  private readonly lanes = new Map<string, ClaudeCodeLane[]>();
  private readonly lanesById = new Map<string, ClaudeCodeLane>();
  private readonly reaper: NodeJS.Timeout;
  private readonly server: http.Server;
  private readonly secret: Buffer;
  private readonly options: ClaudeCodeBridgeOptions;
  readonly port: number;

  private constructor(
    server: http.Server,
    secret: Buffer,
    port: number,
    options: ClaudeCodeBridgeOptions,
  ) {
    this.server = server;
    this.secret = secret;
    this.port = port;
    this.options = options;
    this.reaper = setInterval(() => this.reapLanes(), 30_000);
    this.reaper.unref();
  }

  static async start(options: ClaudeCodeBridgeOptions) {
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
    const port = await listen(server, state.port);
    writeFileSync(statePath, JSON.stringify({ port, secret }), { mode: 0o600 });
    target.bridge = new ClaudeCodeBridge(
      server,
      Buffer.from(secret),
      port,
      { ...options, stateDirectory: lanesDirectory },
    );
    return target.bridge;
  }

  /**
   * A stable API key for one conversation scope. Scopes starting with `op:`
   * are one-off operations whose Claude Code process closes soon after.
   */
  token(scope: string) {
    const encoded = Buffer.from(scope).toString("base64url");
    return `${tokenPrefix}.${encoded}.${this.mac(encoded)}`;
  }

  /** The endpoint Cline calls; an effort picked in Blame rides in the path. */
  baseUrl(host: string, effort?: ClaudeCodeEffort) {
    const prefix = effort ? `/effort/${effort}` : "";
    return `http://${host}:${this.port}${prefix}/v1`;
  }

  async close() {
    clearInterval(this.reaper);
    for (const lane of [...this.lanesById.values()]) lane.close("Blame closed.");
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", "http://bridge");
    if (url.pathname === "/health") return json(response, 200, { ok: true });
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
    const lanes = (this.lanes.get(token) ?? []).filter((lane) => !lane.closed);
    const lane = lanes.find((candidate) => candidate.accepts(parsed));
    let active: ClaudeCodeLane;
    if (lane) {
      lane.continue(parsed, sink);
      active = lane;
    } else {
      active = new ClaudeCodeLane(parsed, sink, {
        env,
        executablePath,
        idleMs: tokenScope(token).startsWith("op:")
          ? operationIdleMs
          : sessionIdleMs,
        mcpBaseUrl: `http://127.0.0.1:${this.port}`,
        stateDirectory: this.options.stateDirectory,
        onClose: (closed) => this.forget(token, closed),
      });
      this.lanesById.set(active.id, active);
      this.lanes.set(token, [...lanes, active]);
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
  }

  private validToken(token: string) {
    const [prefix, encoded, mac, extra] = token.split(".");
    if (prefix !== tokenPrefix || !encoded || !mac || extra !== undefined)
      return false;
    return sameSecret(this.mac(encoded), mac);
  }

  private mac(value: string) {
    return createHmac("sha256", this.secret)
      .update(value)
      .digest("base64url")
      .slice(0, 32);
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
    closeBeyond(this.lanes.get(token) ?? [], maxLanesPerToken);
    closeBeyond([...this.lanesById.values()], maxLanes);
  }

  private forget(token: string, lane: ClaudeCodeLane) {
    this.lanesById.delete(lane.id);
    const lanes = (this.lanes.get(token) ?? []).filter((item) => item !== lane);
    if (lanes.length) this.lanes.set(token, lanes);
    else this.lanes.delete(token);
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

async function listen(server: http.Server, preferred?: number) {
  const bind = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  if (preferred) {
    try {
      return await bind(preferred);
    } catch {
      // The previous port is taken: any free port works, sessions get a new URL.
    }
  }
  return bind(0);
}
