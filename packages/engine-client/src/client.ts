import {
  EngineClosedError,
  EngineExitedError,
  EngineProtocolVersionError,
  EngineRpcError,
  EngineTimeoutError,
  type EngineExit,
} from "./errors.js";
import {
  carriesRemoteLog,
  type HostHandlers,
  type ToolHostContext,
} from "./host.js";
import {
  PROTOCOL_VERSION,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_SERVER_ERROR,
  type ClientMethod,
  type ClientResults,
  type EngineNotification,
  type ErrorKind,
  type HostMethod,
  type Initialized,
  type ParamsOf,
  type RpcId,
  type RpcResponseMessage,
} from "./protocol.js";
import {
  spawnTransport,
  type EngineCommand,
  type Transport,
  type TransportExit,
  type TransportFactory,
} from "./transport.js";

/** Something the client wants to say that is not a protocol message. */
export interface EngineLogLine {
  /** `engine-stderr` is the engine's own output; `client` is this library. */
  source: "engine-stderr" | "client";
  text: string;
}

export interface EngineClientOptions {
  /** Reported to the engine in `initialize`. */
  clientName: string;
  clientVersion: string;
  /** What only this client has: its tools, the user's approval, credentials, log transfer. */
  handlers?: HostHandlers;
  /** stderr of the engine, line by line, and anything unexpected the client noticed. */
  onLog?: (line: EngineLogLine) => void;
  /** Called once when the connection ends, whatever the reason. */
  onExit?: (exit: EngineExit) => void;
  /** How long `initialize` may take (a VM may have to boot first). Default 60 s. */
  startTimeoutMs?: number;
  /** How long a graceful shutdown waits before killing the engine. Default 5 s. */
  shutdownTimeoutMs?: number;
}

/** Options of one request. */
export interface RequestOptions {
  /** Aborting sends `$/cancel` to the engine and rejects the request at once. */
  signal?: AbortSignal;
  /** Rejects (and cancels) when no answer comes in time. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

type HostHandler = (params: never, context: ToolHostContext) => unknown;
type NotificationListener = (notification: EngineNotification) => void;

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const HOST_METHODS: ReadonlySet<string> = new Set<HostMethod>([
  "host/tool",
  "host/approval",
  "host/credential",
  "host/log/push",
  "host/log/pull",
  "host/blob/push",
  "host/blob/pull",
]);

/**
 * One connection to one engine. Create it with {@link EngineClient.start}
 * (a child process) or {@link EngineClient.connect} (any transport); it is
 * ready, and the protocol version already checked, when the promise resolves.
 *
 * A client does not restart its engine: when the connection ends, `closed`
 * resolves, every pending request is rejected, and the owner decides whether
 * to start another (see `EngineSupervisor`).
 */
export class EngineClient {
  /** What the engine said about itself in `initialize`. */
  info!: Initialized;
  /** Resolves, never rejects, when the connection has ended. */
  readonly closed: Promise<EngineExit>;

  private transport!: Transport;
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly inbound = new Map<RpcId, AbortController>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly handlers: HostHandlers;
  private readonly resolveClosed: (exit: EngineExit) => void;
  private ended: EngineExit | undefined;
  private stopping = false;
  private readonly options: EngineClientOptions;

  private constructor(options: EngineClientOptions) {
    this.options = options;
    this.handlers = options.handlers ?? {};
    let resolve!: (exit: EngineExit) => void;
    this.closed = new Promise((r) => {
      resolve = r;
    });
    this.resolveClosed = resolve;
  }

  /** Starts the engine as a child process and completes the handshake. */
  static start(
    command: EngineCommand,
    options: EngineClientOptions,
  ): Promise<EngineClient> {
    return EngineClient.connect(spawnTransport(command), options);
  }

  /** Completes the handshake over a transport the caller provides. */
  static async connect(
    factory: TransportFactory,
    options: EngineClientOptions,
  ): Promise<EngineClient> {
    const remoteLog = carriesRemoteLog(options.handlers ?? {});
    const client = new EngineClient(options);
    client.transport = factory({
      line: (line) => client.onLine(line),
      stderr: (text) => options.onLog?.({ source: "engine-stderr", text }),
      close: (exit) => client.onClose(exit),
    });
    try {
      const info = await client.request(
        "initialize",
        {
          protocol_version: PROTOCOL_VERSION,
          client_name: options.clientName,
          client_version: options.clientVersion,
          remote_log: remoteLog,
        },
        { timeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS },
      );
      if (info.protocol_version !== PROTOCOL_VERSION) {
        throw new EngineProtocolVersionError(
          PROTOCOL_VERSION,
          info.protocol_version,
          info.engine_version,
        );
      }
      client.info = info;
      return client;
    } catch (error) {
      client.kill();
      await client.closed;
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.ended !== undefined;
  }

  /** Receives every record and delta the engine sends, for all subscribed sessions. */
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one request and waits for its result. Prefer the typed methods below. */
  request<M extends ClientMethod>(
    method: M,
    params: ParamsOf<M>,
    options: RequestOptions = {},
  ): Promise<ClientResults[M]> {
    const { signal, timeoutMs } = options;
    if (this.ended) return Promise.reject(this.closedError());
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = this.nextId++;
    return new Promise<ClientResults[M]>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cancel = (reason: unknown) => {
        if (!this.pending.delete(id)) return;
        pending.cleanup();
        this.notify("$/cancel", { id });
        reject(reason);
      };
      const onAbort = () => cancel(abortReason(signal!));
      const pending: Pending = {
        method,
        resolve: (value) => resolve(value as ClientResults[M]),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => cancel(new EngineTimeoutError(`Request ${method}`, timeoutMs)),
          timeoutMs,
        );
      }
      if (
        !this.transport.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        )
      ) {
        this.pending.delete(id);
        pending.cleanup();
        reject(this.closedError());
      }
    });
  }

  createSession(params: ParamsOf<"session/create">, options?: RequestOptions) {
    return this.request("session/create", params, options);
  }

  /** Loads a stored session and finishes whatever a crash interrupted. */
  openSession(params: ParamsOf<"session/open">, options?: RequestOptions) {
    return this.request("session/open", params, options);
  }

  listSessions(options?: RequestOptions) {
    return this.request("session/list", {}, options);
  }

  /** One page of stored records, without subscribing. */
  readRecords(params: ParamsOf<"session/read">, options?: RequestOptions) {
    return this.request("session/read", params, options);
  }

  /** Records after `after` arrive as notifications, then live deltas. See `followSession`. */
  subscribe(params: ParamsOf<"session/subscribe">, options?: RequestOptions) {
    return this.request("session/subscribe", params, options);
  }

  unsubscribe(
    params: ParamsOf<"session/unsubscribe">,
    options?: RequestOptions,
  ) {
    return this.request("session/unsubscribe", params, options);
  }

  sendMessage(params: ParamsOf<"session/send">, options?: RequestOptions) {
    return this.request("session/send", params, options);
  }

  interrupt(params: ParamsOf<"session/interrupt">, options?: RequestOptions) {
    return this.request("session/interrupt", params, options);
  }

  rewind(params: ParamsOf<"session/rewind">, options?: RequestOptions) {
    return this.request("session/rewind", params, options);
  }

  undoRewind(
    params: ParamsOf<"session/undo_rewind">,
    options?: RequestOptions,
  ) {
    return this.request("session/undo_rewind", params, options);
  }

  fork(params: ParamsOf<"session/fork">, options?: RequestOptions) {
    return this.request("session/fork", params, options);
  }

  compact(params: ParamsOf<"session/compact">, options?: RequestOptions) {
    return this.request("session/compact", params, options);
  }

  configure(params: ParamsOf<"session/configure">, options?: RequestOptions) {
    return this.request("session/configure", params, options);
  }

  /** Stops the session and frees its memory; its records stay stored. */
  closeSession(params: ParamsOf<"session/close">, options?: RequestOptions) {
    return this.request("session/close", params, options);
  }

  /** Stores the bytes of an attachment (base64) and returns the reference a message carries. */
  putBlob(params: ParamsOf<"blob/put">, options?: RequestOptions) {
    return this.request("blob/put", params, options);
  }

  /**
   * Asks the engine to stop every session and exit, then waits for it. Kills
   * it when it does not exit within the timeout. Safe to call twice.
   */
  async shutdown(
    timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ) {
    if (this.ended) return this.ended;
    this.stopping = true;
    try {
      await this.request("shutdown", {}, { timeoutMs });
    } catch {
      // Whatever went wrong, closing the input and killing is what is left.
    }
    await this.transport.close(timeoutMs);
    return this.closed;
  }

  /** Kills the engine without asking. */
  kill(): void {
    this.stopping = true;
    this.transport.kill();
  }

  private notify(method: string, params: unknown): void {
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private closedError(): Error {
    return this.ended && !this.ended.expected
      ? new EngineExitedError(this.ended)
      : new EngineClosedError();
  }

  private log(text: string): void {
    this.options.onLog?.({ source: "client", text });
  }

  private onClose(transportExit: TransportExit): void {
    if (this.ended) return;
    const exit: EngineExit = { ...transportExit, expected: this.stopping };
    this.ended = exit;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(this.closedError());
    }
    for (const controller of this.inbound.values())
      controller.abort(this.closedError());
    this.inbound.clear();
    this.resolveClosed(exit);
    try {
      this.options.onExit?.(exit);
    } catch (error) {
      this.log(`onExit threw: ${String(error)}`);
    }
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log(`ignored a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (typeof id === "number")
        void this.serveRequest(id, method, message.params);
      else this.onNotificationMessage(method, message.params);
    } else if (typeof id === "number") {
      this.onResponse(id, message as unknown as RpcResponseMessage);
    } else {
      this.log(
        `ignored a message that is neither a request nor a response: ${line.slice(0, 200)}`,
      );
    }
  }

  private onResponse(id: RpcId, message: RpcResponseMessage): void {
    const pending = this.pending.get(id);
    // The request was cancelled or timed out; its answer arrives late.
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (message.error) {
      pending.reject(
        new EngineRpcError(
          message.error.code,
          message.error.message,
          message.error.data?.kind as ErrorKind,
        ),
      );
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private onNotificationMessage(method: string, params: unknown): void {
    if (method === "$/cancel") {
      const id = (params as { id?: unknown } | undefined)?.id;
      if (typeof id === "number")
        this.inbound
          .get(id)
          ?.abort(new EngineClosedError("Cancelled by the engine"));
      return;
    }
    if (method !== "session/record" && method !== "session/delta") {
      this.log(`ignored notification ${method}`);
      return;
    }
    const notification = { method, params } as EngineNotification;
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (error) {
        // One broken subscriber must not stop the others, nor the reader.
        this.log(`a notification listener threw: ${String(error)}`);
      }
    }
  }

  /** Runs a handler for one request of the engine and answers it, unless the engine withdrew it. */
  private async serveRequest(
    id: RpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const reply = (body: Record<string, unknown>) => {
      this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    };
    if (!HOST_METHODS.has(method)) {
      reply({
        error: {
          code: RPC_METHOD_NOT_FOUND,
          message: `Unknown method ${method}`,
        },
      });
      return;
    }
    const handler = this.handlerFor(method as HostMethod);
    if (!handler) {
      reply({
        error: {
          code: RPC_METHOD_NOT_FOUND,
          message: `This client does not handle ${method}`,
        },
      });
      return;
    }
    if (typeof params !== "object" || params === null) {
      reply({
        error: {
          code: RPC_INVALID_PARAMS,
          message: `${method} needs parameters`,
        },
      });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(id, controller);
    // Only `host/tool` handlers are given this (see `ToolHostContext`).
    const call = (params as { call?: unknown }).call;
    const progress = (text: string) => {
      // Progress after the answer, or for a withdrawn call, goes nowhere.
      if (
        method === "host/tool" &&
        !controller.signal.aborted &&
        this.inbound.has(id)
      )
        this.notify("tool/progress", { call, text });
    };
    try {
      const result = await handler(params as never, {
        signal: controller.signal,
        id,
        progress,
      });
      // A withdrawn request is not answered: the engine already moved on.
      if (!controller.signal.aborted) reply({ result: result ?? null });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      reply({
        error: { code: RPC_SERVER_ERROR, message, data: { kind: "internal" } },
      });
    } finally {
      this.inbound.delete(id);
    }
  }

  private handlerFor(method: HostMethod): HostHandler | undefined {
    const h = this.handlers;
    const table: Record<HostMethod, HostHandler | undefined> = {
      "host/tool": h.tool,
      "host/approval": h.approval,
      "host/credential": h.credential,
      "host/log/push": h.logPush,
      "host/log/pull": h.logPull,
      "host/blob/push": h.blobPush,
      "host/blob/pull": h.blobPull,
    };
    return table[method];
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The request was aborted", "AbortError")
  );
}
