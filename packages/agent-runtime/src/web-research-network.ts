import { lookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import ipaddr from "ipaddr.js";

export function publicWebUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("Only public HTTP(S) pages on standard ports can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    /\.(?:localhost|local|internal|home|lan)$/i.test(host) ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    throw new Error(
      "Private network addresses cannot be read by web research.",
    );
  url.hash = "";
  return url;
}

export function publicAddress(value: string) {
  try {
    return ipaddr.process(value).range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicWebUrl(value: string) {
  const url = publicWebUrl(value);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new Error(
      "The page resolves to a private or reserved network address.",
    );
  return { url, addresses };
}

/** Resolve and pin each connection, including redirects, to public addresses. */
export async function downloadWebPage(
  value: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ url: string; body: string; contentType: string }> {
  signal.throwIfAborted();
  if (redirects > 5) throw new Error("Too many page redirects.");
  const { url, addresses } = await resolvePublicWebUrl(value);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(
      url,
      {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; BlameResearch/1.0)",
          Accept: "text/html,text/plain,application/xhtml+xml",
          "Accept-Encoding": "identity",
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      },
      (response) => {
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
          response.headers.location
        ) {
          response.destroy();
          void downloadWebPage(
            new URL(response.headers.location, url).href,
            signal,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (!response.statusCode || response.statusCode >= 400) {
          response.destroy();
          reject(
            new Error(
              `Page returned HTTP ${response.statusCode ?? "unknown"}.`,
            ),
          );
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        if (
          !/^(?:text\/|application\/(?:xhtml\+xml|json|xml))/i.test(contentType)
        ) {
          response.destroy();
          reject(new Error("This URL is not a text page."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 5_000_000) {
            response.destroy(new Error("Page exceeds the 5 MB reading limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const charset =
            contentType.match(/charset=["']?([^;\s"']+)/i)?.[1] ?? "utf-8";
          let decoder: TextDecoder;
          try {
            decoder = new TextDecoder(charset);
          } catch {
            decoder = new TextDecoder();
          }
          resolve({
            url: url.href,
            body: decoder.decode(Buffer.concat(chunks)),
            contentType,
          });
        });
      },
    );
    request.on("error", reject);
  });
}
