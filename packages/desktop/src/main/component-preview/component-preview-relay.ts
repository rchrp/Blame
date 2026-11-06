import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { DesktopBridgeGrant } from "../preview-browser/preview-bridge-grant.ts";
import {
  providerHeaders,
  providerTarget,
  responseHeaders,
} from "../preview-browser/preview-provider-headers.ts";
import { PreviewRouteTable } from "../preview-browser/preview-route-table.ts";

// The component preview server of a cloud preview runs in the sandbox. This
// relay gives it an origin on this computer, http://127.0.0.1:<port>, like
// a local server: the component preview page, its request policy and its
// HMR WebSocket stay the same. Each request goes to the server's own route,
// checked like the preview's (an https sandbox provider and a capability),
// with a capability renewed before it expires. The preview's network bridge
// and its routes are never involved.

export type ComponentPreviewRelayTransport = {
  request(
    target: URL,
    options: { headers: OutgoingHttpHeaders; method?: string; timeout: number },
  ): ClientRequest;
  // A raw connection for a WebSocket upgrade; `ready` runs once it is open.
  connect(target: URL, ready: () => void): net.Socket;
};

export const providerTransport: ComponentPreviewRelayTransport = {
  request: (target, options) =>
    target.protocol === "https:"
      ? httpsRequest(target, options)
      : httpRequest(target, options),
  connect: (target, ready) =>
    target.protocol === "https:"
      ? tls.connect(
          {
            ALPNProtocols: ["http/1.1"],
            host: target.hostname,
            port: Number(target.port || 443),
            servername: target.hostname,
          },
          ready,
        )
      : net.connect(
          { host: target.hostname, port: Number(target.port || 80) },
          ready,
        ),
};

// A capability lives 60 s; a request never leaves with one about to expire.
const refreshMarginMs = 20_000;
const upstreamTimeoutMs = 10 * 60_000;

export class ComponentPreviewRelay {
  private expiresAt = 0;
  private logicalPort?: number;
  private origin?: URL;
  private refreshing?: Promise<void>;
  private readonly refreshGrant: () => Promise<DesktopBridgeGrant>;
  private readonly routes = new PreviewRouteTable();
  private readonly server = createServer((request, response) => {
    void this.forwardHttp(request, response).catch(() => {
      if (!response.headersSent)
        response.writeHead(502, { "cache-control": "no-store" });
      response.end("Component preview unavailable");
    });
  });
  private readonly sockets = new Set<Duplex>();
  private readonly transport: ComponentPreviewRelayTransport;

  constructor(
    refreshGrant: () => Promise<DesktopBridgeGrant>,
    transport: ComponentPreviewRelayTransport = providerTransport,
  ) {
    this.refreshGrant = refreshGrant;
    this.transport = transport;
    this.server.on("connection", (socket) => this.track(socket));
    this.server.on("upgrade", (request, socket, head: Buffer) => {
      void this.forwardWebSocket(request, socket, head).catch(() =>
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"),
      );
    });
  }

  // Listens on this computer's loopback only.
  async listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.origin = new URL(`http://127.0.0.1:${port}`);
  }

  // The server's route, from its start or a refresh.
  use(grant: DesktopBridgeGrant) {
    const [route] = grant.routes;
    if (grant.routes.length !== 1 || !route)
      throw new Error("The component preview route is invalid.");
    this.routes.replace(grant, "cloud");
    this.logicalPort = route.logicalPort;
    this.expiresAt = Date.parse(route.capabilityExpiresAt);
  }

  async close() {
    this.routes.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async forwardHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const { route, url } = await this.route(request.url);
    const target = providerTarget(route.providerUrl, url);
    const upstream = this.transport.request(target, {
      headers: providerHeaders(request.headers, target, route.capability),
      method: request.method,
      timeout: upstreamTimeoutMs,
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("response", (result) => {
        response.writeHead(
          result.statusCode ?? 502,
          responseHeaders(result.headers, (value) => this.relayLocation(value)),
        );
        result.pipe(response).once("finish", resolve).once("error", reject);
      });
      upstream.once("timeout", () =>
        upstream.destroy(new Error("Component preview request timed out")),
      );
      upstream.once("error", reject);
      request.pipe(upstream);
    });
  }

  private async forwardWebSocket(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ) {
    if (
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    )
      throw new Error("Invalid component preview WebSocket upgrade");
    const { route, url } = await this.route(request.url);
    const target = providerTarget(route.providerUrl, url);
    const headers = providerHeaders(request.headers, target, route.capability);
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const upstream = this.transport.connect(target, () => {
      upstream.write(
        [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          ...Object.entries(headers).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map(
              (item) => `${name}: ${item}`,
            ),
          ),
          "",
          "",
        ].join("\r\n"),
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    this.track(upstream);
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.setTimeout(upstreamTimeoutMs);
    upstream.once("timeout", close);
    upstream.once("error", close);
    upstream.once("close", close);
    client.once("error", close);
    client.once("close", close);
  }

  private async route(path: string | undefined) {
    if (this.logicalPort === undefined)
      throw new Error("The component preview server has no route yet.");
    if (this.expiresAt - Date.now() < refreshMarginMs) await this.refresh();
    return this.routes.resolve(
      `http://localhost:${this.logicalPort}${path ?? "/"}`,
    );
  }

  private refresh() {
    this.refreshing ??= this.refreshGrant()
      .then((grant) => this.use(grant))
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  // A redirect to the provider or to the server's logical origin stays on
  // this relay's origin, the only one the page may load.
  private relayLocation(value: string) {
    const logical = this.routes.rewriteProviderLocation(value);
    try {
      const url = new URL(logical);
      if (
        this.origin &&
        url.hostname === "localhost" &&
        Number(url.port) === this.logicalPort
      ) {
        url.host = this.origin.host;
        return url.toString();
      }
    } catch {
      // A relative location stays as it is.
    }
    return logical;
  }

  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
}
