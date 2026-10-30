import log from "electron-log";

// What a preview's localhost proxy is doing, so a page that never finishes
// loading can be explained from main.log: the requests still open and how
// far each got, the last failure, and how the last route refresh went.
// Paths only: query strings can carry tokens.

type Stage = "routes" | "upstream" | "response";

type OpenRequest = {
  kind: "http" | "websocket";
  path: string;
  stage: Stage;
  startedAt: number;
};

const failureLogIntervalMs = 10_000;

export class PreviewBridgeActivity {
  private readonly open = new Map<number, OpenRequest>();
  private nextId = 0;
  private forwarded = 0;
  private failed = 0;
  private lastFailure?: { path: string; message: string; at: number };
  private lastRefresh?: {
    startedAt: number;
    durationMs?: number;
    error?: string;
  };
  private lastLogged = new Map<string, number>();

  private readonly port: () => number | undefined;

  constructor(port: () => number | undefined) {
    this.port = port;
  }

  start(kind: OpenRequest["kind"], url: string | undefined) {
    const id = this.nextId++;
    this.open.set(id, {
      kind,
      path: requestPath(url),
      stage: "routes",
      startedAt: Date.now(),
    });
    return {
      stage: (stage: Stage) => {
        const request = this.open.get(id);
        if (request) request.stage = stage;
      },
      done: () => {
        if (this.open.delete(id)) this.forwarded += 1;
      },
      fail: (error: unknown) => {
        const request = this.open.get(id);
        if (!this.open.delete(id)) return;
        this.failed += 1;
        const message = errorMessage(error);
        this.lastFailure = { path: request!.path, message, at: Date.now() };
        this.warn(
          message,
          `Preview proxy request failed at ${request!.stage}`,
          {
            kind: request!.kind,
            path: request!.path,
            error: message,
          },
        );
      },
    };
  }

  refreshStarted() {
    const startedAt = Date.now();
    this.lastRefresh = { startedAt };
    return (error?: unknown) => {
      if (this.lastRefresh?.startedAt !== startedAt) return;
      this.lastRefresh.durationMs = Date.now() - startedAt;
      if (error === undefined) return;
      this.lastRefresh.error = errorMessage(error);
      this.warn(this.lastRefresh.error, "Preview proxy routes refresh failed", {
        durationMs: this.lastRefresh.durationMs,
        error: this.lastRefresh.error,
      });
    };
  }

  snapshot() {
    const now = Date.now();
    return {
      port: this.port(),
      forwarded: this.forwarded,
      failed: this.failed,
      open: [...this.open.values()].slice(0, 20).map((request) => ({
        kind: request.kind,
        path: request.path,
        stage: request.stage,
        ageMs: now - request.startedAt,
      })),
      openCount: this.open.size,
      lastFailure: this.lastFailure && {
        ...this.lastFailure,
        ageMs: now - this.lastFailure.at,
      },
      lastRefresh: this.lastRefresh && {
        ageMs: now - this.lastRefresh.startedAt,
        durationMs: this.lastRefresh.durationMs ?? null,
        error: this.lastRefresh.error,
      },
    };
  }

  // The same failure repeats for every request of a page: log it once
  // every few seconds.
  private warn(key: string, message: string, details: object) {
    const now = Date.now();
    if (now - (this.lastLogged.get(key) ?? 0) < failureLogIntervalMs) return;
    this.lastLogged.set(key, now);
    log.warn(message, JSON.stringify({ port: this.port(), ...details }));
  }
}

function requestPath(url: string | undefined) {
  try {
    return new URL(url ?? "", "http://preview.invalid").pathname.slice(0, 160);
  } catch {
    return "(invalid)";
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** Logs why a preview page did not load, with the proxy Chromium used. */
export function logStuckPreviewLoad(input: {
  url: string;
  proxy: Promise<string>;
  visible: boolean;
  bridge?: { diagnostics(): object };
}) {
  void input.proxy
    .catch(() => "unknown")
    .then((proxy) =>
      log.warn(
        "Preview page did not finish loading",
        JSON.stringify({
          url: logUrl(input.url),
          proxy,
          visible: input.visible,
          bridge: input.bridge?.diagnostics() ?? null,
        }),
      ),
    );
}

export function logPreviewLoadFailure(
  code: number,
  description: string,
  url: string,
) {
  log.warn(
    "Preview page failed to load",
    JSON.stringify({ code, description, url: logUrl(url) }),
  );
}

function logUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid)";
  }
}
