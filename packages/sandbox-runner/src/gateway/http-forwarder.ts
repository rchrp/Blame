import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { nextDevResourceOrigin } from "./next-dev-origin.js";

const maximumBodyBytes = 50 * 1024 * 1024;

export type GatewayRoute = {
  sessionId: string;
  routeId: string;
  serviceId: string;
  endpointId: string;
  generation: number;
  logicalPort: number;
  sandboxPort: number;
  targetHost: string;
  targetPort: number;
};

export async function forwardHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: GatewayRoute,
) {
  const path = gatewayRequestTarget(request.url);
  const headers = forwardedRequestHeaders(request.headers, route, path);
  const upstream = http.request({
    host: route.targetHost,
    port: route.targetPort,
    method: request.method,
    path,
    headers,
    timeout: 10 * 60_000,
  });
  const completed = new Promise<void>((resolve, reject) => {
    upstream.once("response", async (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        forwardedResponseHeaders(upstreamResponse.headers, route),
      );
      try {
        await pipeline(upstreamResponse, response);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    upstream.once("timeout", () =>
      upstream.destroy(new Error("Upstream request timed out.")),
    );
    upstream.once("error", reject);
  });
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maximumBodyBytes)
      upstream.destroy(new Error("Request body limit exceeded."));
  });
  await Promise.all([pipeline(request, upstream), completed]);
}

export function gatewayRequestTarget(value: string | undefined) {
  if (
    !value ||
    value.length > 16_384 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Invalid gateway request target.");
  }
  const base = new URL("http://gateway.invalid/");
  const target = new URL(value, base);
  if (target.origin !== base.origin || target.hash) {
    throw new Error("Invalid gateway request target.");
  }
  return `${target.pathname}${target.search}`;
}

export function forwardedRequestHeaders(
  source: IncomingMessage["headers"],
  route: GatewayRoute,
  target = "/",
) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      name.startsWith("x-blame-") ||
      [
        "connection",
        "proxy-authorization",
        "proxy-authenticate",
        "upgrade",
      ].includes(name)
    ) {
      continue;
    }
    headers[name] = value;
  }
  const logicalOrigin = `http://localhost:${route.logicalPort}`;
  headers.host = `localhost:${route.logicalPort}`;
  const devOrigin = nextDevResourceOrigin(source, target, logicalOrigin);
  if (devOrigin) headers.origin = devOrigin;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-host"] = `localhost:${route.logicalPort}`;
  headers["x-forwarded-port"] = String(route.logicalPort);
  return headers;
}

function forwardedResponseHeaders(
  source: IncomingMessage["headers"],
  route: GatewayRoute,
) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      name.startsWith("x-blame-") ||
      ["connection", "upgrade"].includes(name)
    ) {
      continue;
    }
    if (name === "location" && typeof value === "string") {
      headers[name] = rewriteLocation(value, route);
    } else headers[name] = value;
  }
  return headers;
}

function rewriteLocation(value: string, route: GatewayRoute) {
  try {
    const url = new URL(
      value,
      `http://${route.targetHost}:${route.targetPort}`,
    );
    if (
      url.hostname !== route.targetHost ||
      Number(url.port || 80) !== route.targetPort
    )
      return value;
    url.hostname = "localhost";
    url.port = String(route.logicalPort);
    return url.toString();
  } catch {
    return value;
  }
}
