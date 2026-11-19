import { randomBytes } from "node:crypto";
import {
  startCdpWebSocketServer,
  type CdpSocket,
  type CdpWebSocketServer,
} from "./cdp-websocket-server.ts";

// Presents one preview page to agent-browser as a browser with a single
// page. Browser-level CDP is answered here; page commands go to the page's
// own debugger, without opening any Chromium debugging port. The client can
// attach to that page and its frames only: it cannot open, create or close
// targets, and navigation stays on the preview.

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
  wsEndpoint: string;
};

type ClientMessage = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type Reply = { error: string } | { result: unknown };

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
  const server: CdpWebSocketServer = await startCdpWebSocketServer({
    connect: (socket) => {
      state.connect(socket);
      return {
        closed: () => void close(),
        message: (text) => void state.receive(text),
      };
    },
  }).catch((error) => {
    debuggee.detach();
    throw error;
  });
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
  return { close, closed, wsEndpoint: server.wsEndpoint };
}

class ProxyState {
  // Sessions the client opened on the page, and on its frames and workers.
  private readonly pageSessions = new Set<string>();
  private readonly children = new Set<string>();
  private socket?: CdpSocket;
  private stopMessages?: () => void;
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
    this.pageSessions.forEach((sessionId) =>
      this.emit("Target.detachedFromTarget", {
        sessionId,
        targetId: this.targetId,
      }),
    );
    this.emit("Target.targetDestroyed", { targetId: this.targetId });
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
    const reply = await this.dispatch(message).catch((error): Reply => ({
      error: errorMessage(error),
    }));
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
    if (this.pageSessions.has(message.sessionId))
      return this.pageCommand(message.method, params);
    if (this.children.has(message.sessionId))
      return this.childCommand(message.method, params, message.sessionId);
    return { error: `Session with given id not found: ${message.sessionId}` };
  }

  private browserCommand(
    method: string,
    params: Record<string, unknown>,
  ): Reply {
    switch (method) {
      case "Browser.getVersion":
        return { result: this.version() };
      case "Target.setDiscoverTargets":
        if (params.discover === true)
          this.emit("Target.targetCreated", { targetInfo: this.pageInfo() });
        return { result: {} };
      case "Target.getTargets":
        return { result: { targetInfos: [this.pageInfo()] } };
      case "Target.getTargetInfo":
        return params.targetId === undefined ||
          params.targetId === this.targetId
          ? { result: { targetInfo: this.pageInfo() } }
          : { error: "No target with given id found" };
      case "Target.activateTarget":
        return params.targetId === this.targetId
          ? { result: {} }
          : notAllowed(method);
      case "Target.attachToTarget":
        return this.attachPage(params);
      case "Target.detachFromTarget":
        return this.detachPage(params);
      default:
        return notAllowed(method);
    }
  }

  private async pageCommand(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Reply> {
    if (method === "Target.getTargetInfo")
      return { result: { targetInfo: this.pageInfo() } };
    if (method === "Browser.getVersion") return { result: this.version() };
    if (method.startsWith("Browser.") || method === "Page.close")
      return notAllowed(method);
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

  private attachPage(params: Record<string, unknown>): Reply {
    if (params.targetId !== this.targetId)
      return {
        error: "Blame preview DevTools only exposes the scoped preview page.",
      };
    if (params.flatten !== true)
      return { error: "Only flattened sessions are supported." };
    const sessionId = sessionToken();
    this.pageSessions.add(sessionId);
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: this.pageInfo(),
      waitingForDebugger: false,
    });
    return { result: { sessionId } };
  }

  private detachPage(params: Record<string, unknown>): Reply {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !this.pageSessions.has(sessionId))
      return notAllowed("Target.detachFromTarget");
    this.pageSessions.delete(sessionId);
    this.emit("Target.detachedFromTarget", {
      sessionId,
      targetId: this.targetId,
    });
    return { result: {} };
  }

  // The page's events go to every session the client opened on it; a
  // frame's or worker's go to its own session.
  private relay(method: string, params: unknown, sessionId?: string) {
    if (sessionId) {
      if (!this.children.has(sessionId)) return;
      this.trackChildren(method, params);
      this.emit(method, params, sessionId);
      return;
    }
    this.trackChildren(method, params);
    this.pageSessions.forEach((session) => this.emit(method, params, session));
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
    } else return;
    this.emit("Target.targetInfoChanged", { targetInfo: this.pageInfo() });
  }

  private pageInfo() {
    return {
      attached: this.pageSessions.size > 0,
      browserContextId,
      canAccessOpener: false,
      targetId: this.targetId,
      title: this.debuggee.title(),
      type: "page",
      url: this.url,
    };
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
