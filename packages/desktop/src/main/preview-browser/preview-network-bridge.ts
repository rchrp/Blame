import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { Session } from "electron";
import type {
  DesktopBridgeGrant,
  PreviewBridgeProvider,
} from "./preview-bridge-grant";
import { PreviewRouteTable } from "./preview-route-table";
import { PreviewBridgeActivity } from "./preview-bridge-activity";

type GrantProvider = () => Promise<DesktopBridgeGrant>;
type Tracked = ReturnType<PreviewBridgeActivity["start"]>;

const grantRefreshTimeoutMs = 15_000;

const LOOPBACK_REQUEST_PATTERNS = [
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
  "http://0.0.0.0/*",
  "ws://localhost/*",
  "ws://127.0.0.1/*",
  "ws://[::1]/*",
  "ws://0.0.0.0/*",
];

export class PreviewNetworkBridge {
  private readonly auth = randomBytes(32).toString("base64url");
  private readonly routes = new PreviewRouteTable();
  private readonly sockets = new Set<Duplex>();
  private grantExpiresAt = 0;
  private refreshing?: Promise<void>;
  private readonly activity = new PreviewBridgeActivity(() => this.port);
  private server = createServer((request, response) => {
    const tracked = this.activity.start("http", request.url);
    void this.forwardHttp(request, response, tracked).then(
      tracked.done,
      (error) => {
        tracked.fail(error);
        if (!response.headersSent)
          response.writeHead(502, { "cache-control": "no-store" });
        response.end("Preview unavailable");
      },
    );
  });
  private port?: number;

  constructor(
    private readonly partition: Session,
    private readonly grantProvider: GrantProvider,
    private readonly expectedProvider: PreviewBridgeProvider = "cloud",
  ) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (request, socket, head) => {
      const tracked = this.activity.start("websocket", request.url);
      void this.forwardWebSocket(request, socket, head, tracked).catch(
        (error) => {
          tracked.fail(error);
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        },
      );
    });
  }

  async start() {
    if (this.port) return;
    await this.refreshRoutes();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.installRequestGuards();
    await this.partition.setProxy({
      mode: "fixed_servers",
      // Chromium cannot subtract its implicit loopback bypass while using a
      // PAC file. A manual HTTP proxy plus the subtractive rule is therefore
      // required to retain the logical localhost origin. HTTPS remains direct;
      // V1 only guarantees HTTP/WS logical preview origins.
      proxyRules: `http=127.0.0.1:${this.port};https=direct://`,
      proxyBypassRules: "<-loopback>",
    });
    await this.partition.forceReloadProxyConfig();
    const resolved = await this.partition.resolveProxy(
      "http://localhost:65534/__blame_probe",
    );
    if (!resolved.includes(`127.0.0.1:${this.port}`)) {
      await this.close();
      throw new Error("Electron bypassed the isolated localhost preview proxy");
    }
  }

  async close() {
    this.routes.clear();
    await this.partition.clearStorageData({
      storages: ["serviceworkers", "cachestorage"],
    });
    await this.partition.setProxy({ mode: "direct" });
    if (this.server.listening) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    this.port = undefined;
  }

  disableRoutes() {
    this.routes.clear();
  }

  expectedOrigin(value: string | undefined) {
    return this.routes.isExpectedOrigin(value);
  }

  /** What the proxy is doing, for main.log when a preview is stuck. */
  diagnostics() {
    return this.activity.snapshot();
  }

  private installRequestGuards() {
    this.partition.webRequest.onBeforeSendHeaders(
      { urls: LOOPBACK_REQUEST_PATTERNS },
      (details, callback) => {
        details.requestHeaders["x-blame-preview-proxy-auth"] = this.auth;
        callback({ requestHeaders: details.requestHeaders });
      },
    );
    this.partition.webRequest.onBeforeRequest(
      { urls: LOOPBACK_REQUEST_PATTERNS },
      (details, callback) => {
        // Electron does not expose Chromium's `initiator` on this event. The
        // requesting WebFrameMain URL is the authoritative source for normal
        // subresources, with referrer covering workers and early navigations.
        const requestOrigin =
          details.frame?.url ||
          details.referrer ||
          details.webContents?.getURL();
        const allowed =
          this.routes.isExpectedOrigin(details.url) &&
          (details.resourceType === "mainFrame" ||
            this.routes.isExpectedOrigin(requestOrigin));
        callback({ cancel: !allowed });
      },
    );
  }

  private async ensureFreshRoutes() {
    if (this.grantExpiresAt > Date.now() + 8_000) return;
    await this.refreshRoutes();
  }

  private refreshRoutes() {
    if (this.refreshing) return this.refreshing;
    const finished = this.activity.refreshStarted();
    // A refresh that never settles would hold every request forever.
    this.refreshing = withTimeout(this.grantProvider(), grantRefreshTimeoutMs)
      .then((grant) => {
        this.routes.replace(grant, this.expectedProvider);
        this.grantExpiresAt = grant.routes.length
          ? Math.min(
              ...grant.routes.map((route) =>
                Date.parse(route.capabilityExpiresAt),
              ),
            )
          : 0;
      })
      .then(
        () => finished(),
        (error: unknown) => {
          finished(error);
          throw error;
        },
      )
      .finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async forwardHttp(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    tracked: Tracked,
  ) {
    this.authorize(request);
    await this.ensureFreshRoutes();
    tracked.stage("upstream");
    const { route, url } = this.routes.resolve(request.url ?? "");
    const provider = providerTarget(route.providerUrl, url);
    const requestProvider =
      provider.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = requestProvider(provider, {
      method: request.method,
      headers: providerHeaders(request.headers, provider, route.capability),
      timeout: 10 * 60_000,
    });
    const completed = new Promise<void>((resolve, reject) => {
      upstream.once("response", (result) => {
        tracked.stage("response");
        response.writeHead(
          result.statusCode ?? 502,
          responseHeaders(result.headers, (value) =>
            this.routes.rewriteProviderLocation(value),
          ),
        );
        result.pipe(response).once("finish", resolve).once("error", reject);
      });
      upstream.once("timeout", () =>
        upstream.destroy(new Error("Preview request timed out")),
      );
      upstream.once("error", reject);
    });
    request.pipe(upstream);
    await completed;
  }

  private async forwardWebSocket(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
    tracked: Tracked,
  ) {
    this.authorize(request);
    if (
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      throw new Error("Invalid preview WebSocket upgrade");
    }
    await this.ensureFreshRoutes();
    tracked.stage("upstream");
    const { route, url } = this.routes.resolve(request.url ?? "");
    const provider = providerTarget(route.providerUrl, url);
    const secure = provider.protocol === "https:";
    const upstream = secure
      ? tls.connect({
          host: provider.hostname,
          port: Number(provider.port || 443),
          servername: provider.hostname,
          ALPNProtocols: ["http/1.1"],
        })
      : net.connect({
          host: provider.hostname,
          port: Number(provider.port || 80),
        });
    upstream.setTimeout(10 * 60_000);
    upstream.once(secure ? "secureConnect" : "connect", () => {
      tracked.done();
      const headers = providerHeaders(
        request.headers,
        provider,
        route.capability,
      );
      headers.connection = "Upgrade";
      headers.upgrade = request.headers.upgrade ?? "websocket";
      const lines = [
        `${request.method ?? "GET"} ${provider.pathname}${provider.search} HTTP/1.1`,
        ...Object.entries(headers).flatMap(([name, value]) =>
          Array.isArray(value)
            ? value.map((item) => `${name}: ${item}`)
            : [`${name}: ${value}`],
        ),
        "",
        "",
      ];
      upstream.write(lines.join("\r\n"));
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    const close = () => {
      tracked.fail(new Error("Closed before the upstream connected"));
      upstream.destroy();
      client.destroy();
    };
    upstream.once("timeout", close);
    upstream.once("error", close);
    client.once("error", close);
    client.once("close", close);
  }

  private authorize(request: IncomingMessage) {
    const value = request.headers["x-blame-preview-proxy-auth"];
    const actual = Buffer.from(Array.isArray(value) ? "" : (value ?? ""));
    const expected = Buffer.from(this.auth);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Preview proxy authentication failed");
    }
  }
}

function providerTarget(providerUrl: string, logical: URL) {
  const target = new URL(providerUrl);
  target.pathname = logical.pathname;
  target.search = logical.search;
  return target;
}

function providerHeaders(
  source: IncomingHttpHeaders,
  target: URL,
  capability?: string,
) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      name === "host" ||
      name.startsWith("x-blame-") ||
      [
        "connection",
        "proxy-authorization",
        "proxy-authenticate",
        "upgrade",
      ].includes(name)
    )
      continue;
    headers[name] = value;
  }
  headers.host = target.host;
  if (capability) headers["x-blame-preview-capability"] = capability;
  return headers;
}

function responseHeaders(
  source: IncomingHttpHeaders,
  rewriteLocation: (value: string) => string,
) {
  return Object.fromEntries(
    Object.entries(source).flatMap(([name, value]) => {
      if (
        value === undefined ||
        name.startsWith("x-blame-") ||
        ["connection", "transfer-encoding"].includes(name)
      )
        return [];
      if (name === "set-cookie") {
        const values = Array.isArray(value) ? value : [value];
        return [
          [
            name,
            values.map((cookie) => cookie.replace(/;\s*Domain=[^;]+/gi, "")),
          ],
        ];
      }
      if (name === "location" && typeof value === "string")
        return [[name, rewriteLocation(value)]];
      return [[name, value]];
    }),
  ) as Record<string, string | string[]>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Preview routes did not refresh in time")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
