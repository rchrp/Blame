import type { IncomingMessage } from "node:http";

/**
 * Next.js 16 refuses its dev-only resources (the HMR WebSocket, the error
 * overlay's `/__nextjs_*` endpoints) to every `Origin` that is not `localhost`
 * or listed in the project's `allowedDevOrigins`. In a Cloud Preview the browser
 * sends `Origin: https://<hash>.preview.blame.so`, so `next dev` answers
 * `Unauthorized` and the open preview never hot reloads.
 *
 * The gateway already presents each service as `localhost:<logical port>` (see
 * `forwardedRequestHeaders`). For these Next-owned paths it does the same for
 * `Origin`, so the check passes without touching the project's `next.config`,
 * the dev command or the Compose plan. Any other path keeps the browser's real
 * `Origin`: CORS and CSRF checks of the application itself still compare it with
 * the public origin the environment variables carry.
 */
export function isNextDevResource(target: string) {
  const path = target.split("?", 1)[0] ?? "";
  // The same test as Next's own check, which also serves behind a basePath.
  return path.includes("/_next") || path.includes("/__nextjs");
}

/** The `Origin` to send to the service, or undefined to keep the received one. */
export function nextDevResourceOrigin(
  headers: IncomingMessage["headers"],
  target: string,
  logicalOrigin: string,
) {
  const origin = headers.origin;
  if (typeof origin !== "string" || !isNextDevResource(target)) return;
  if (!browserVouchesSameOrigin(headers["sec-fetch-site"])) return;
  try {
    const { protocol, hostname } = new URL(origin);
    if (!["http:", "https:"].includes(protocol)) return;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return;
  } catch {
    // `Origin: null` (an opaque origin) or garbage: Next decides.
    return;
  }
  return logicalOrigin;
}

/**
 * `Sec-Fetch-Site` is set by the browser and cannot be forged by a page. A page
 * of another site reaching this preview says `cross-site` or `same-site`, and
 * keeps Next's own protection. A browser that sends nothing (Safari before 16.4)
 * is treated like the preview's own page.
 */
function browserVouchesSameOrigin(value: string | string[] | undefined) {
  return value === undefined || value === "same-origin" || value === "none";
}
