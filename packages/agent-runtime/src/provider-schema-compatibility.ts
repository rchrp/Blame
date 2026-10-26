import { withoutNativeWebSearch } from './web-research-policy.js';

const schemaContainerKeys = new Set([
  "inputSchema",
  "input_schema",
  "parameters",
  "schema",
]);

const localGrammarConstraintKeys = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
]);

const localProviderHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

type SchemaNormalizationOptions = {
  simplifyLocalGrammar?: boolean;
};

export function createProviderCompatibleFetch(
  request: typeof fetch = globalThis.fetch,
  options: { requestMaxOutputTokens?: number } = {},
): typeof fetch {
  const maximum = options.requestMaxOutputTokens;
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1))
    throw new Error("The per-request output limit must be a positive safe integer.");
  return async (input, init) => {
    const compatible = await compatibleRequestInit(input, init);
    if (maximum === undefined || !isCodexResponsesRequest(input))
      return request(input, compatible);
    return codexOutputLimit(input, compatible, maximum).then((limited) => request(input, limited));
  };
}

/** The SDK gateway omits this field on Codex; the endpoint accepts it. */
async function codexOutputLimit(
  input: Parameters<typeof fetch>[0], init: RequestInit | undefined, maximum: number,
): Promise<RequestInit | undefined> {
  const original = input instanceof Request ? input : undefined;
  if ((init?.method ?? original?.method ?? "GET").toUpperCase() !== "POST") return init;
  const signal = init?.signal === undefined ? original?.signal : init.signal;
  signal?.throwIfAborted();
  const body = typeof init?.body === "string" ? init.body
    : init?.body == null && original ? await original.clone().text() : undefined;
  let payload: unknown;
  try { payload = body === undefined ? undefined : JSON.parse(body); } catch { /* rejected below */ }
  if (!isRecord(payload) || typeof payload.model !== "string")
    throw new Error("A configured Codex output limit requires an inspectable JSON model request.");
  const current = payload.max_output_tokens;
  if (current !== undefined && (typeof current !== "number" || !Number.isSafeInteger(current) || current < 1))
    throw new Error("Invalid max_output_tokens in the Codex model request.");
  if (typeof current === "number" && current <= maximum) return init;
  const headers = new Headers(init?.headers ?? original?.headers);
  // A rewritten body has a new byte length; fetch computes it when transmitting.
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify({ ...payload, max_output_tokens: maximum }) };
}

function isCodexResponsesRequest(input: Parameters<typeof fetch>[0]) {
  try {
    const url = new URL(requestUrl(input));
    return url.protocol === "https:" && url.hostname === "chatgpt.com" &&
      /^\/backend-api\/codex\/responses\/?$/u.test(url.pathname);
  } catch { return false; }
}

export function normalizeProviderPayload(
  value: unknown,
  options: SchemaNormalizationOptions = {},
): unknown {
  if (Array.isArray(value))
    return value.map((child) => normalizeProviderPayload(child, options));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      schemaContainerKeys.has(key)
        ? normalizeJsonSchema(child, options)
        : normalizeProviderPayload(child, options),
    ]),
  );
}

export function normalizeJsonSchema(
  value: unknown,
  options: SchemaNormalizationOptions = {},
): unknown {
  if (Array.isArray(value))
    return value.map((child) => normalizeJsonSchema(child, options));
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (options.simplifyLocalGrammar && localGrammarConstraintKeys.has(key))
        return [];
      if (key === "pattern" && unsupportedProviderPattern(child)) return [];
      return [[key, normalizeJsonSchema(child, options)]];
    }),
  );
}

async function compatibleRequestInit(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const original = input instanceof Request ? input : undefined;
  const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
  const originalBody = typeof init?.body === 'string' ? init.body
    : init?.body == null && original && method === 'POST' ? await original.clone().text() : undefined;
  if (originalBody === undefined) return init;
  const body = compatibleJsonBody(
    originalBody,
    { simplifyLocalGrammar: isLocalProviderRequest(input) },
    isResponsesRequest(input),
  );
  if (body === originalBody) return init;
  const headers = new Headers(init?.headers ?? original?.headers);
  headers.delete('content-length');
  return { ...init, headers, body };
}

function compatibleJsonBody(
  body: string,
  options: SchemaNormalizationOptions,
  responsesRequest: boolean,
) {
  try {
    const payload = withoutNativeWebSearch(normalizeProviderPayload(JSON.parse(body), options));
    return JSON.stringify(
      responsesRequest ? compatibleResponsesPayload(payload) : payload,
    );
  } catch {
    return body;
  }
}

function compatibleResponsesPayload(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.tools)) return value;
  return {
    ...value,
    tools: value.tools.map((tool) =>
      isRecord(tool) &&
      tool.type === "function" &&
      typeof tool.name === "string" &&
      tool.strict === undefined
        ? { ...tool, strict: false }
        : tool,
    ),
  };
}

function isResponsesRequest(input: Parameters<typeof fetch>[0]) {
  try {
    return /\/responses\/?$/.test(new URL(requestUrl(input)).pathname);
  } catch {
    return false;
  }
}

function isLocalProviderRequest(input: Parameters<typeof fetch>[0]) {
  try {
    return localProviderHosts.has(new URL(requestUrl(input)).hostname);
  } catch {
    return false;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function unsupportedProviderPattern(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    new RegExp(value);
  } catch {
    return true;
  }
  return unsupportedRegexSyntax(value);
}

function unsupportedRegexSyntax(pattern: string) {
  return (
    /(^|[^\\])\(\?(?:[=!]|<[=!]|>|\()/.test(pattern) ||
    /(^|[^\\])\\(?:[1-9]|k<)/.test(pattern) ||
    /(^|[^\\])(?:[+*?]|\{\d+(?:,\d*)?\})\+/.test(pattern)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
