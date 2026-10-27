import type { AgentToolContext } from "@cline/sdk";

type WebFetchExecutor = (url: string, prompt: string, context: AgentToolContext) => Promise<string>;
type WebFetchOptions = { timeoutMs?: number; maxResponseBytes?: number };
type DecodedBody = {
  pending: Buffer;
  decoder?: TextDecoder;
  content: string[];
};

const binaryMediaTypes = new Set([
  "application/gzip", "application/x-gzip", "application/zip",
  "application/x-zip-compressed", "application/x-compress",
  "application/x-bzip2", "application/x-xz", "application/x-7z-compressed",
  "application/x-rar-compressed", "application/vnd.rar", "application/x-tar",
  "application/x-lzh", "application/pdf", "application/wasm",
]);

export function describeTextWebFetch<T extends { name: string }>({ request }: { request: { tools: readonly T[] } }) {
  return { tools: request.tools.map((tool) => tool.name === "fetch_web_content" ? {
    ...tool,
    description: "Retrieve text from URLs for the agent to analyze. The prompt indicates the focus of that analysis; the tool returns page text or metadata for binary resources. Fetch independent URLs together.",
  } : tool) };
}

export function createTextWebFetchExecutor(options: WebFetchOptions = {}): WebFetchExecutor {
  const { timeoutMs = 30_000, maxResponseBytes = 5_000_000 } = options;
  return async (url, prompt, context) => {
    validateWebUrl(url);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
    try {
      signal.throwIfAborted();
      return await fetchWebContent(url, prompt, signal, maxResponseBytes);
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      if (timeout.aborted) throw new Error(`Request timed out after ${timeoutMs}ms`, { cause: error });
      throw error;
    }
  };
}

function validateWebUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL: ${value}`); }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error(`Invalid protocol: ${url.protocol}. Only http and https are supported.`);
}

async function fetchWebContent(url: string, prompt: string, signal: AbortSignal, limit: number) {
  const response = await fetch(url, {
    method: "GET", redirect: "follow", signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const resolvedUrl = response.url || url;
    const contentType = response.headers.get("content-type") ?? "";
    if (isBinaryMediaType(contentType)) return binaryResponse(resolvedUrl, response);
    const body = await readWebBody(response, limit, signal);
    return body.content === undefined ? binaryResponse(resolvedUrl, response) :
      formatWebContent(resolvedUrl, prompt, contentType, body.content, body.bytes);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

function isBinaryMediaType(contentType: string) {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return binaryMediaTypes.has(mediaType) ||
    /^(?:audio|video|font)\//u.test(mediaType) ||
    mediaType.startsWith("image/") && mediaType !== "image/svg+xml";
}

async function readWebBody(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed to read response body");
  const state: DecodedBody = { pending: Buffer.alloc(0), content: [] };
  const contentType = response.headers.get("content-type") ?? "";
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(`Response too large: exceeded ${limit} bytes`);
      if (!decodeWebChunk(state, value, contentType)) return { bytes };
    }
    return { bytes, content: finishWebBody(state, contentType) };
  } finally {
    reader.releaseLock();
  }
}

function decodeWebChunk(state: DecodedBody, bytes: Uint8Array, contentType: string) {
  if (!state.decoder) {
    state.pending = Buffer.concat([state.pending, bytes]);
    if (state.pending.length < 4) return true;
    state.decoder = webTextDecoder(state.pending, contentType);
    bytes = state.pending;
    state.pending = Buffer.alloc(0);
  }
  const text = state.decoder.decode(bytes, { stream: true });
  if (hasBinaryControls(text)) return false;
  state.content.push(text);
  return true;
}

function finishWebBody(state: DecodedBody, contentType: string) {
  const decoder = state.decoder ?? webTextDecoder(state.pending, contentType);
  const text = decoder.decode(state.pending);
  return hasBinaryControls(text) ? undefined : [...state.content, text].join("");
}

function webTextDecoder(bytes: Uint8Array, contentType: string) {
  const bom = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" :
    bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/iu)?.[1];
  try { return new TextDecoder(bom ?? charset ?? "utf-8"); }
  catch { return new TextDecoder("utf-8"); }
}

function hasBinaryControls(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) return true;
  }
  return false;
}

function binaryResponse(url: string, response: Response) {
  return [
    `URL: ${url.slice(0, 2048)}`,
    `Content-Type: ${(response.headers.get("content-type") ?? "unknown").slice(0, 256)}`,
    `Content-Length: ${(response.headers.get("content-length") ?? "unknown").slice(0, 32)}`,
    "Binary response body omitted. Download this resource to a file with a shell command if needed.",
  ].join("\n");
}

function formatWebContent(url: string, prompt: string, contentType: string, source: string, bytes: number) {
  const content = webContentText(source, contentType);
  const output = [`URL: ${url}`, `Content-Type: ${contentType}`, `Size: ${bytes} bytes`, "", "--- Content ---", content.slice(0, 50_000)];
  if (content.length > 50_000)
    output.push(`\n[Content truncated: showing first 50000 of ${content.length} characters]`);
  return [...output, "", "--- Analysis Request ---", `Prompt: ${prompt}`].join("\n");
}

function webContentText(source: string, contentType: string) {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml"))
    return htmlText(source);
  if (contentType.includes("application/json")) {
    try { return JSON.stringify(JSON.parse(source), null, 2); } catch { return source; }
  }
  return source;
}

function htmlText(source: string) {
  return source.replace(/<script[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(p|div|br|hr|h[1-6]|li|tr)[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/\s+/gu, " ").replace(/\n\s+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n").trim();
}
