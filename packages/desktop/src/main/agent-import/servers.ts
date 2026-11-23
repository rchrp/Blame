import { parse as parseToml } from "smol-toml";

/**
 * MCP servers as the other tools write them, read into one shape. These
 * parsers only read: they never run a command or open a URL, and they keep
 * going past an entry they cannot read.
 */
export type ImportedServer = {
  /** The key it had in its file. */
  name: string;
  transport: "stdio" | "streamableHttp" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Seconds. */
  timeout?: number;
  /** Switched off in the source. */
  disabled: boolean;
  /** `user`, or a project's path. */
  scope?: string;
  /** What will not carry over; a server with some is imported switched off. */
  warnings: string[];
  /** What the person should know that does not stop it from working. */
  notes: string[];
};

export type ParsedServers = {
  servers: ImportedServer[];
  /** Installed by an app (Codex's computer use…): not the person's. */
  bundled: number;
};

const empty = (): ParsedServers => ({ servers: [], bundled: 0 });

/** JSON with comments and trailing commas, as VS Code writes it. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    // Comments or trailing commas: strip them below.
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^﻿/, ""));
}

/**
 * `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`:
 * Claude Desktop, Claude Code, Cursor. VS Code's `servers` key is the same.
 */
export function parseServersTable(
  table: unknown,
  scope?: string,
  options: { bareUrl?: "streamableHttp" | "sse" } = {},
): ParsedServers {
  const result = empty();
  if (!isRecord(table)) return result;
  for (const [name, raw] of Object.entries(table)) {
    const server = fromJsonEntry(name, raw, scope, options.bareUrl);
    if (server) result.servers.push(server);
  }
  return result;
}

/**
 * OpenCode and Kilo Code: `mcp` holds the servers by name (the newer OpenCode
 * schema nests them under `mcp.servers`), `type: "local"` with `command` as
 * one array, or `type: "remote"` with a `url`; `enabled: false` or
 * `disabled: true` switches one off.
 */
export function parseOpenCodeMcp(mcp: unknown): ParsedServers {
  const result = empty();
  if (!isRecord(mcp)) return result;
  const table = isRecord(mcp.servers) ? mcp.servers : mcp;
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    const server = base(
      name,
      raw.type === "remote" || (!raw.command && raw.url)
        ? "streamableHttp"
        : "stdio",
    );
    if (server.transport === "stdio") {
      const [command, ...args] = Array.isArray(raw.command)
        ? raw.command.filter((part): part is string => typeof part === "string")
        : [text(raw.command), ...(strings(raw.args) ?? [])];
      if (!command) continue;
      server.command = command;
      server.args = args.filter(
        (arg): arg is string => typeof arg === "string",
      );
      server.cwd = text(raw.cwd);
      server.env = stringMap(raw.environment) ?? stringMap(raw.env);
    } else {
      server.url = text(raw.url);
      if (!server.url) continue;
      server.headers = stringMap(raw.headers);
    }
    server.disabled = raw.enabled === false || raw.disabled === true;
    server.timeout = seconds(raw.timeout);
    const finished = finish(server);
    if (finished) result.servers.push(finished);
  }
  return result;
}

/**
 * Zed's `context_servers`: `command` is an object (`path`, `args`, `env`) or
 * a string; a server with a `url` is remote; one given by an extension (no
 * command, no url) is not the person's.
 */
export function parseZedServers(table: unknown): ParsedServers {
  const result = empty();
  if (!isRecord(table)) return result;
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    const command = isRecord(raw.command) ? raw.command : raw;
    const entry = {
      ...raw,
      command: isRecord(raw.command) ? text(raw.command.path) : raw.command,
      args: command.args,
      env: command.env,
      disabled: raw.enabled === false,
    };
    const server = fromJsonEntry(name, entry);
    if (server) result.servers.push(server);
  }
  return result;
}

/**
 * Goose's `extensions` (config.yaml): `stdio` with `cmd`, `args`, `envs`, or
 * `streamable_http` with `uri`. Built-in and platform extensions come with
 * Goose and are counted as bundled; `env_keys` live in its keyring.
 */
export function parseGooseExtensions(table: unknown): ParsedServers {
  const result = empty();
  if (!isRecord(table)) return result;
  for (const [key, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    if (
      raw.bundled === true ||
      (raw.type !== "stdio" &&
        raw.type !== "streamable_http" &&
        raw.type !== "sse")
    ) {
      result.bundled++;
      continue;
    }
    const remote = raw.type !== "stdio";
    const server = base(
      text(raw.name) ?? key,
      remote ? (raw.type === "sse" ? "sse" : "streamableHttp") : "stdio",
    );
    if (remote) {
      server.url = text(raw.uri);
      if (!server.url) continue;
      server.headers = stringMap(raw.headers);
    } else {
      server.command = text(raw.cmd);
      if (!server.command) continue;
      server.args = strings(raw.args);
      server.env = stringMap(raw.envs);
    }
    const keys = strings(raw.env_keys);
    if (keys?.length)
      server.warnings.push(
        `Reads ${keys.join(", ")} from Goose's keyring, which Blame cannot. Put the values in after importing.`,
      );
    server.disabled = raw.enabled === false;
    server.timeout = seconds(raw.timeout);
    const finished = finish(server);
    if (finished) result.servers.push(finished);
  }
  return result;
}

export function parseCodexConfig(text: string): ParsedServers {
  const result = empty();
  let config: Record<string, unknown>;
  try {
    config = parseToml(text) as Record<string, unknown>;
  } catch {
    return result;
  }
  const table = config.mcp_servers;
  if (!isRecord(table)) return result;
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    if (bundledByApp(raw)) {
      result.bundled++;
      continue;
    }
    const server = fromCodexEntry(name, raw);
    if (server) result.servers.push(server);
  }
  return result;
}

function fromJsonEntry(
  name: string,
  raw: unknown,
  scope?: string,
  bareUrl: "streamableHttp" | "sse" = "streamableHttp",
): ImportedServer | undefined {
  if (!isRecord(raw)) return undefined;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  // Gemini CLI and Qwen Code: `httpUrl` is Streamable HTTP, `url` is SSE.
  // Windsurf writes `serverUrl`.
  const url = text(raw.httpUrl) ?? text(raw.url) ?? text(raw.serverUrl);
  const command = text(raw.command);
  const transport =
    type === "sse"
      ? "sse"
      : type === "http" ||
          type === "streamable-http" ||
          type === "streamablehttp"
        ? "streamableHttp"
        : type === "stdio" || type === "local"
          ? "stdio"
          : url && !command
            ? text(raw.httpUrl)
              ? "streamableHttp"
              : bareUrl
            : "stdio";
  const server = base(name, transport, scope);
  if (transport === "stdio") {
    if (!command) return undefined;
    server.command = command;
    server.args = strings(raw.args);
    server.cwd = text(raw.cwd) ?? text(raw.workingDirectory);
    server.env = stringMap(raw.env);
  } else {
    if (!url) return undefined;
    server.url = url;
    server.headers = stringMap(raw.headers);
  }
  server.disabled = raw.disabled === true || raw.enabled === false;
  server.timeout = seconds(raw.timeout);
  return finish(server);
}

function fromCodexEntry(
  name: string,
  raw: Record<string, unknown>,
): ImportedServer | undefined {
  const url = text(raw.url);
  const command = text(raw.command);
  const server = base(name, url && !command ? "streamableHttp" : "stdio");
  if (server.transport === "stdio") {
    if (!command) return undefined;
    server.command = command;
    server.args = strings(raw.args);
    server.cwd = text(raw.cwd);
    server.env = stringMap(raw.env);
  } else {
    server.url = url;
    server.headers = stringMap(raw.http_headers);
    const bearer = text(raw.bearer_token_env_var);
    if (bearer)
      server.warnings.push(
        `Signs in with the environment variable ${bearer}, which Blame does not read.`,
      );
    const fromEnv = stringMap(raw.env_http_headers);
    if (fromEnv)
      server.warnings.push(
        `Headers ${Object.keys(fromEnv).join(", ")} come from environment variables, which Blame does not read.`,
      );
  }
  server.disabled = raw.enabled === false;
  server.timeout = seconds(raw.tool_timeout_sec);
  return finish(server);
}

function bundledByApp(raw: Record<string, unknown>) {
  const where = [text(raw.command), text(raw.cwd)].join(" ");
  return /(ChatGPT|Codex)[^/\\]*\.app[/\\]|Codex Computer Use/i.test(where);
}

function base(
  name: string,
  transport: ImportedServer["transport"],
  scope?: string,
): ImportedServer {
  return { name, transport, disabled: false, scope, warnings: [], notes: [] };
}

// `${NAME}` is expanded by Claude Code and Cursor, `${input:id}` asks VS
// Code for a value. Blame does neither, so the server is imported switched
// off until the person puts a value in.
function finish(server: ImportedServer): ImportedServer | undefined {
  if (server.name.trim() === "" || server.name.length > 80) return undefined;
  const values = [
    server.command,
    server.cwd,
    server.url,
    ...(server.args ?? []),
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ];
  const placeholders = new Set<string>();
  for (const value of values)
    for (const match of value?.matchAll(/\$\{([^}:]+(?::[^}]*)?)\}/g) ?? [])
      placeholders.add(match[0]);
  if (placeholders.size)
    server.warnings.push(
      `Uses ${[...placeholders].join(", ")}, which Blame does not expand. Put the value in after importing.`,
    );
  if (
    server.transport !== "stdio" &&
    !Object.keys(server.headers ?? {}).some((key) => /authorization/i.test(key))
  )
    server.notes.push(
      "If it asks you to sign in, authorize it again in Blame.",
    );
  return server;
}

/** `?token=abc` and `user:pass@` are secrets too. */
export function maskedUrl(value: string) {
  try {
    const url = new URL(value);
    const hadLogin = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()])
      url.searchParams.set(key, "••••");
    const text = decodeURIComponent(url.toString());
    return hadLogin ? text.replace("://", "://••••@") : text;
  } catch {
    return "(invalid URL)";
  }
}

export function secretNames(server: ImportedServer) {
  const names = [
    ...Object.keys(server.env ?? {}),
    ...Object.keys(server.headers ?? {}),
  ];
  if (server.url && maskedUrl(server.url) !== server.url) names.push("URL");
  if (maskedArguments(server).masked) names.push("Arguments");
  return names;
}

/** What the server runs or reaches, without a secret in it. */
export function serverSummary(server: ImportedServer) {
  if (server.transport !== "stdio") return maskedUrl(server.url ?? "");
  return [server.command, ...maskedArguments(server).args].join(" ");
}

// An argument can carry a token: `--api-key=…`, `--api-key …`, `-e TOKEN=…`,
// a URL with a password or a key in its query.
const secretName = /(key|token|secret|password|passwd|auth|credential)/i;

function maskedArguments(server: ImportedServer) {
  let masked = false;
  let hideNext = false;
  const args = (server.args ?? []).map((value) => {
    const hide = () => {
      masked = true;
      return "••••";
    };
    if (hideNext) {
      hideNext = false;
      return hide();
    }
    if (/^--?[\w-]+$/.test(value) && secretName.test(value)) {
      hideNext = true;
      return value;
    }
    const assignment = /^(--?[\w-]+|[A-Za-z0-9_]+)=(.*)$/.exec(value);
    if (assignment && secretName.test(assignment[1]!)) {
      masked = true;
      return `${assignment[1]}=••••`;
    }
    const inner = assignment ? assignment[2]! : value;
    if (/^[a-z][a-z0-9+.-]*:\/\/[^\s]*[@?]/i.test(inner)) {
      const hidden = maskedUrl(inner);
      if (hidden !== inner) {
        masked = true;
        return assignment ? `${assignment[1]}=${hidden}` : hidden;
      }
    }
    return value;
  });
  return { args, masked };
}

export function fingerprint(server: {
  transport: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
}) {
  return JSON.stringify(
    server.transport === "stdio"
      ? ["stdio", server.command, server.args ?? [], server.cwd ?? ""]
      : [server.transport, server.url],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}
function stringMap(value: unknown) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, item]) =>
    key.trim() && (typeof item === "string" || typeof item === "number")
      ? [[key, String(item)] as const]
      : [],
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
function seconds(value: unknown) {
  const number = typeof value === "number" ? value : undefined;
  if (number === undefined) return undefined;
  // Claude Code and Cursor count milliseconds; Codex counts seconds.
  const inSeconds = number > 3600 ? Math.round(number / 1000) : number;
  return Number.isInteger(inSeconds) && inSeconds >= 1 && inSeconds <= 3600
    ? inSeconds
    : undefined;
}
