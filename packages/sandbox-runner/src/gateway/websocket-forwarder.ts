import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import net from "node:net";
import {
  forwardedRequestHeaders,
  gatewayRequestTarget,
  type GatewayRoute,
} from "./http-forwarder.js";

export function forwardWebSocket(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  route: GatewayRoute,
) {
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
    client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  let requestTarget: string;
  try {
    requestTarget = gatewayRequestTarget(request.url);
  } catch {
    client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect(route.targetPort, route.targetHost);
  upstream.setTimeout(10 * 60_000);
  upstream.once("connect", () => {
    const headers = forwardedRequestHeaders(request.headers, route, requestTarget);
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade ?? "websocket";
    const lines = [
      `${request.method ?? "GET"} ${requestTarget} HTTP/${request.httpVersion}`,
      ...Object.entries(headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`],
      ),
      "",
      "",
    ];
    upstream.write(lines.join("\r\n"));
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.once("timeout", close);
  upstream.once("error", close);
  client.once("error", close);
  client.once("close", close);
}
