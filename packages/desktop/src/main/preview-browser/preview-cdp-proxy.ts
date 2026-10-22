import { randomBytes } from "node:crypto";
import {
  startCdpWebSocketServer,
  type CdpSocket,
  type CdpWebSocketServer,
} from "./cdp-websocket-server.ts";

// Presents one preview page to chrome-devtools-mcp as if it were a whole
// browser. Browser-level CDP is answered here; page commands go to the
// page's own debugger, without opening any Chromium debugging port.

export type CdpDebuggee = {
  attach(): Promise<{ targetId: string }>;
  detach(): void;
  onDetach(listener: () => void): () => void;
  onMessage(
    listener: (method: string, params: unknown, sessionId?: string) => void,
  ): () => void;
  sendCommand(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<unknown>;
  contentSize(): { height: number; width: number };
  setContentSize?(width: number, height: number): Promise<void> | void;
  title(): string;
  url(): string;
  userAgent(): string;
  versions: { chrome: string; v8: string };
};

export type CdpProxyPolicy = {
  navigationAllowed(url: string): boolean;
};

export type PreviewCdpProxy = {
  close(): Promise<void>;
  closed: Promise<void>;
  httpUrl: string;
  wsEndpoint: string;
};

type ClientMessage = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type Reply = { error: string } | { result: unknown };

const windowId = 1;
const browserContextId = sessionToken();

export class CdpProxyError extends Error {}

export async function startPreviewCdpProxy(
  debuggee: CdpDebuggee,
  policy: CdpProxyPolicy,
): Promise<PreviewCdpProxy> {
  const { targetId } = await debuggee.attach();
  const state = new ProxyState(debuggee, policy, targetId);
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let wsEndpoint = "";
  const server: CdpWebSocketServer = await startCdpWebSocketServer({
    connect: (socket) => {
      state.connect(socket);
      return {
        closed: () => void close(),
        message: (text) => void state.receive(text),
      };
    },
    json: (kind) => state.json(kind, wsEndpoint),
  }).catch((error) => {
    debuggee.detach();
    throw error;
  });
  wsEndpoint = server.wsEndpoint;
  const stopDetach = debuggee.onDetach(() => {
    state.targetGone();
    void close();
  });
  function close() {
    closing ??= (async () => {
      stopDetach();
      state.dispose();
      await server.close();
      resolveClosed();
    })();
    return closing;
  }
  return {
    close,
    closed,
    httpUrl: server.httpUrl,
    wsEndpoint: server.wsEndpoint,
  };
}

class ProxyState {
  private readonly aliases = new Set<string>();
  private readonly children = new Set<string>();
  private readonly pageSession = sessionToken();
  private readonly tabSession = sessionToken();
  private readonly tabId = sessionToken();
  private pageAttached = false;
  private socket?: CdpSocket;
  private stopMessages?: () => void;
  private tabAttached = false;
  private url: string;

  private readonly debuggee: CdpDebuggee;
  private readonly policy: CdpProxyPolicy;
  private readonly targetId: string;

  constructor(debuggee: CdpDebuggee, policy: CdpProxyPolicy, targetId: string) {
    this.debuggee = debuggee;
    this.policy = policy;
    this.targetId = targetId;
    this.url = debuggee.url();
  }

  connect(socket: CdpSocket) {
    this.socket = socket;
    this.stopMessages = this.debuggee.onMessage((method, params, sessionId) =>
      this.relay(method, params, sessionId),
    );
  }

  dispose() {
    this.stopMessages?.();
    this.stopMessages = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.debuggee.detach();
  }

  targetGone() {
    if (this.pageAttached)
      this.emit(
        "Target.detachedFromTarget",
        { sessionId: this.pageSession, targetId: this.targetId },
        this.tabSession,
      );
    this.emit("Target.targetDestroyed", { targetId: this.targetId });
    this.emit("Target.targetDestroyed", { targetId: this.tabId });
  }

  json(kind: "list" | "version", wsEndpoint: string) {
    if (kind === "version")
      return { ...this.version(), webSocketDebuggerUrl: wsEndpoint };
    return [
      {
        description: "",
        id: this.targetId,
        title: this.debuggee.title(),
        type: "page",
        url: this.url,
      },
    ];
  }

  async receive(text: string) {
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (typeof message?.id !== "number" || typeof message.method !== "string")
      return;
    const reply = await this.dispatch(message).catch(
      (error): Reply => ({ error: errorMessage(error) }),
    );
    this.send({
      id: message.id,
      ...("error" in reply
        ? { error: { code: -32000, message: reply.error } }
        : { result: reply.result ?? {} }),
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    });
  }

  private async dispatch(message: ClientMessage): Promise<Reply> {
    const params = message.params ?? {};
    if (!message.sessionId) return this.browserCommand(message.method, params);
    if (message.sessionId === this.tabSession)
      return this.tabCommand(message.method);
    if (message.sessionId === this.pageSession)
      return this.pageCommand(message.method, params, "primary");
    if (this.aliases.has(message.sessionId))
      return this.pageCommand(message.method, params, "alias");
    if (this.children.has(message.sessionId))
      return this.childCommand(message.method, params, message.sessionId);
    return { error: `Session with given id not found: ${message.sessionId}` };
  }

  private browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Reply | Promise<Reply> {
    switch (method) {
      case "Browser.getVersion":
        return { result: this.version() };
      case "Target.getBrowserContexts":
        return { result: { browserContextIds: [] } };
      case "Target.setDiscoverTargets":
        if (params.discover === true) {
          this.emit("Target.targetCreated", { targetInfo: this.tabInfo() });
          this.emit("Target.targetCreated", { targetInfo: this.pageInfo() });
        }
        return { result: {} };
      case "Target.setAutoAttach":
        if (params.autoAttach === true && !this.tabAttached) {
          this.tabAttached = true;
          this.emit("Target.attachedToTarget", {
            sessionId: this.tabSession,
            targetInfo: this.tabInfo(),
            waitingForDebugger: false,
          });
        }
        return { result: {} };
      case "Target.getTargets":
        return { result: { targetInfos: [this.tabInfo(), this.pageInfo()] } };
      case "Target.getTargetInfo":
        return this.targetInfo(params.targetId);
      case "Target.activateTarget":
        return this.knownTarget(params.targetId)
          ? { result: {} }
          : notAllowed(method);
      case "Target.attachToTarget":
        return this.attachAlias(params);
      case "Target.detachFromTarget":
        return this.detachAlias(params);
      default:
        return this.windowCommand(method, params) ?? notAllowed(method);
    }
  }

  private tabCommand(method: string): Reply {
    if (method === "Target.setAutoAttach") {
      if (!this.pageAttached) {
        this.pageAttached = true;
        this.emit(
          "Target.attachedToTarget",
          {
            sessionId: this.pageSession,
            targetInfo: this.pageInfo(),
            waitingForDebugger: false,
          },
          this.tabSession,
        );
      }
      return { result: {} };
    }
    if (method === "Runtime.runIfWaitingForDebugger") return { result: {} };
    if (method === "Target.getTargetInfo")
      return { result: { targetInfo: this.tabInfo() } };
    return notAllowed(method);
  }

  private async pageCommand(
    method: string,
    params: Record<string, unknown>,
    kind: "alias" | "primary",
  ): Promise<Reply> {
    if (method === "Target.setAutoAttach" && kind === "alias")
      return { result: {} };
    if (kind === "alias" && method.endsWith(".disable")) return { result: {} };
    if (method === "Target.getTargetInfo")
      return { result: { targetInfo: this.pageInfo() } };
    if (method === "Target.activateTarget") return { result: {} };
    if (method.startsWith("Browser."))
      return this.windowCommand(method, params) ?? notAllowed(method);
    if (method === "Page.close") return notAllowed(method);
    return this.forward(method, params, undefined);
  }

  private childCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) {
    if (method.startsWith("Browser.")) return notAllowed(method);
    return this.forward(method, params, sessionId);
  }

  private async forward(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<Reply> {
    if (
      method.startsWith("Target.") &&
      !allowedPageTargetCommand(method, params, this.children)
    )
      return notAllowed(method);
    if (method === "Page.navigate") this.assertNavigation(params.url);
    if (method === "Page.navigateToHistoryEntry")
      await this.assertHistoryEntry(params.entryId, sessionId);
    return {
      result: await this.debuggee.sendCommand(method, params, sessionId),
    };
  }

  private assertNavigation(url: unknown) {
    if (typeof url !== "string" || !this.policy.navigationAllowed(url))
      throw new CdpProxyError(
        `Navigation to ${String(url)} is blocked: the agent browser can only open the preview origin or about:blank.`,
      );
  }

  private async assertHistoryEntry(entryId: unknown, sessionId?: string) {
    const history = (await this.debuggee.sendCommand(
      "Page.getNavigationHistory",
      {},
      sessionId,
    )) as { entries?: Array<{ id: number; url: string }> };
    const entry = history.entries?.find(({ id }) => id === entryId);
    this.assertNavigation(entry?.url);
  }

  private windowCommand(
    method: string,
    params: Record<string, unknown>,
  ): Reply | Promise<Reply> | undefined {
    if (method === "Browser.getVersion") return { result: this.version() };
    if (method === "Browser.getWindowForTarget") {
      if (params.targetId !== undefined && !this.knownTarget(params.targetId))
        return { error: "No target with given id found" };
      return { result: { bounds: this.bounds(), windowId } };
    }
    if (method === "Browser.getWindowBounds")
      return { result: { bounds: this.bounds() } };
    if (method === "Browser.setContentsSize")
      return this.resize(params.width, params.height);
    if (method === "Browser.setWindowBounds") {
      const bounds = recordValue(params.bounds);
      return this.resize(bounds.width, bounds.height);
    }
    return undefined;
  }

  private async resize(width: unknown, height: unknown): Promise<Reply> {
    if (!this.debuggee.setContentSize)
      return { error: "Resizing is not available for this preview." };
    const current = this.debuggee.contentSize();
    await this.debuggee.setContentSize(
      dimension(width, current.width),
      dimension(height, current.height),
    );
    return { result: {} };
  }

  private attachAlias(params: Record<string, unknown>): Reply {
    if (params.targetId !== this.targetId)
      return {
        error: "Blame preview DevTools only exposes the scoped preview page.",
      };
    if (params.flatten !== true)
      return { error: "Only flattened sessions are supported." };
    const sessionId = sessionToken();
    this.aliases.add(sessionId);
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: this.pageInfo(),
      waitingForDebugger: false,
    });
    return { result: { sessionId } };
  }

  private detachAlias(params: Record<string, unknown>): Reply {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !this.aliases.has(sessionId))
      return notAllowed("Target.detachFromTarget");
    this.aliases.delete(sessionId);
    this.emit("Target.detachedFromTarget", {
      sessionId,
      targetId: this.targetId,
    });
    return { result: {} };
  }

  private relay(method: string, params: unknown, sessionId?: string) {
    if (sessionId) {
      if (!this.children.has(sessionId)) return;
      this.trackChildren(method, params);
      this.emit(method, params, sessionId);
      return;
    }
    this.trackChildren(method, params);
    if (!this.pageAttached) return;
    this.emit(method, params, this.pageSession);
    if (!method.startsWith("Target."))
      this.aliases.forEach((alias) => this.emit(method, params, alias));
    this.trackNavigation(method, params);
  }

  private trackChildren(method: string, params: unknown) {
    const sessionId = recordValue(params).sessionId;
    if (typeof sessionId !== "string") return;
    if (method === "Target.attachedToTarget") this.children.add(sessionId);
    if (method === "Target.detachedFromTarget") this.children.delete(sessionId);
  }

  private trackNavigation(method: string, params: unknown) {
    const value = recordValue(params);
    if (method === "Page.frameNavigated") {
      const frame = recordValue(value.frame);
      if (frame.parentId || typeof frame.url !== "string") return;
      this.url = frame.url;
    } else if (method === "Page.navigatedWithinDocument") {
      if (typeof value.url !== "string") return;
      this.url = value.url;
    } else if (method !== "Page.loadEventFired") return;
    this.emit("Target.targetInfoChanged", { targetInfo: this.pageInfo() });
    this.emit("Target.targetInfoChanged", { targetInfo: this.tabInfo() });
  }

  private targetInfo(targetId: unknown): Reply {
    if (targetId === undefined || targetId === this.targetId)
      return { result: { targetInfo: this.pageInfo() } };
    if (targetId === this.tabId)
      return { result: { targetInfo: this.tabInfo() } };
    return { error: "No target with given id found" };
  }

  private knownTarget(targetId: unknown) {
    return targetId === this.targetId || targetId === this.tabId;
  }

  private pageInfo() {
    return this.info(this.targetId, "page", this.pageAttached);
  }

  private tabInfo() {
    return this.info(this.tabId, "tab", this.tabAttached);
  }

  private info(targetId: string, type: string, attached: boolean) {
    return {
      attached,
      browserContextId,
      canAccessOpener: false,
      targetId,
      title: this.debuggee.title(),
      type,
      url: this.url,
    };
  }

  private bounds() {
    const { height, width } = this.debuggee.contentSize();
    return { height, left: 0, top: 0, width, windowState: "normal" };
  }

  private version() {
    return {
      jsVersion: this.debuggee.versions.v8,
      product: `Chrome/${this.debuggee.versions.chrome}`,
      protocolVersion: "1.3",
      revision: "",
      userAgent: this.debuggee.userAgent(),
    };
  }

  private emit(method: string, params: unknown, sessionId?: string) {
    this.send({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private send(message: unknown) {
    this.socket?.send(JSON.stringify(message));
  }
}

function allowedPageTargetCommand(
  method: string,
  params: Record<string, unknown>,
  children: Set<string>,
) {
  if (method === "Target.setAutoAttach") return true;
  if (method === "Target.detachFromTarget")
    return (
      typeof params.sessionId === "string" && children.has(params.sessionId)
    );
  return false;
}

function notAllowed(method: string): Reply {
  return {
    error: `${method} is not allowed in Blame preview DevTools.`,
  };
}

function dimension(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 200), 4_096);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sessionToken() {
  return randomBytes(16).toString("hex").toUpperCase();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
