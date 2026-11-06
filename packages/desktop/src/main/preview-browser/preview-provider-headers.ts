import type { IncomingHttpHeaders } from "node:http";

// How a request for a logical localhost origin reaches a preview provider,
// and how its answer comes back: shared by the preview's network bridge and
// the component preview relay of a cloud preview.

export function providerTarget(providerUrl: string, logical: URL) {
  const target = new URL(providerUrl);
  target.pathname = logical.pathname;
  target.search = logical.search;
  return target;
}

export function providerHeaders(
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

export function responseHeaders(
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
