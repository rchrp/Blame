// OAuth for the user's remote MCP servers, with the MCP SDK: the state
// (client registration, tokens, PKCE verifier) lives in the MCP settings
// file next to the server, so Settings → MCP shows it and every process that
// connects to the server uses the same tokens. Authorizing opens the
// server's sign-in page in the browser and waits for its redirect to a
// loopback address; a connection refreshes its tokens itself and, when the
// server wants a new sign-in, fails with a message that says where to give it.

import { readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  configuredMcpServers,
  mcpSettingsPath,
  readMcpOAuthState,
  updateMcpOAuthState,
  type McpOAuthState,
  type McpServer,
} from "./mcp-settings.js";

export type McpOAuthStatus = {
  configured: boolean;
  lastAuthenticatedAt?: number;
  lastError?: string;
  serverName: string;
  supported: boolean;
};

const callbackPorts = [1456, 1457, 1458];
const callbackPath = "/mcp/oauth/callback";
const authorizationTimeoutMs = 300_000;

/** The OAuth state of a server, as the MCP SDK reads and writes it. */
export class SettingsOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly path: string;
  private readonly redirect: string | undefined;
  private readonly onAuthorizationUrl:
    ((url: URL) => Promise<void>) | undefined;
  private cached: McpOAuthState | undefined;

  constructor(options: {
    serverName: string;
    path?: string;
    /** Set while the user authorizes: the loopback address of the redirect. */
    redirectUrl?: string;
    onAuthorizationUrl?(url: URL): Promise<void>;
  }) {
    this.serverName = options.serverName;
    this.path = options.path ?? mcpSettingsPath();
    this.redirect = options.redirectUrl;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
  }

  get redirectUrl() {
    return this.redirect ?? this.cached?.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Blame",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation() {
    return (await this.current()).clientInformation as
      OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(information: OAuthClientInformationMixed) {
    await this.update((state) => ({
      ...state,
      clientInformation: { ...information },
    }));
  }

  async tokens() {
    return (await this.current()).tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.update((state) => ({
      ...state,
      tokens: { ...tokens },
      lastAuthenticatedAt: Date.now(),
      authorizationRequired: false,
      lastError: undefined,
    }));
  }

  async redirectToAuthorization(url: URL) {
    if (!this.onAuthorizationUrl) {
      await this.update((state) => ({ ...state, authorizationRequired: true }));
      throw new Error(
        `MCP server "${this.serverName}" needs a new sign-in: authorize it in Settings → MCP.`,
      );
    }
    await this.onAuthorizationUrl(url);
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.update((state) => ({
      ...state,
      codeVerifier,
      ...(this.redirect ? { redirectUrl: this.redirect } : {}),
    }));
  }

  async codeVerifier() {
    const verifier = (await this.current()).codeVerifier;
    if (!verifier) throw new Error("No OAuth code verifier was saved.");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier") {
    await this.update((state) => {
      if (scope === "all") return {};
      if (scope === "client") return { ...state, clientInformation: undefined };
      if (scope === "tokens") return { ...state, tokens: undefined };
      return { ...state, codeVerifier: undefined };
    });
  }

  private async current() {
    this.cached = await readMcpOAuthState(this.serverName, this.path);
    return this.cached;
  }

  private async update(change: (state: McpOAuthState) => McpOAuthState) {
    this.cached = await updateMcpOAuthState(this.serverName, change, this.path);
  }
}

export async function listMcpOAuthStatuses(
  filePath = mcpSettingsPath(),
): Promise<McpOAuthStatus[]> {
  return (await configuredMcpServers(filePath))
    .map(({ server, oauth }) => {
      const supported = server.transport.type !== "stdio";
      const token = oauth.tokens?.access_token;
      return {
        serverName: server.name,
        supported,
        configured:
          supported && typeof token === "string" && token.trim().length > 0,
        ...(oauth.lastError ? { lastError: oauth.lastError } : {}),
        ...(oauth.lastAuthenticatedAt
          ? { lastAuthenticatedAt: oauth.lastAuthenticatedAt }
          : {}),
      };
    })
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
}

/** Forgets a server's sign-in. */
export function clearMcpOAuth(filePath: string, serverName: string) {
  const settings = JSON.parse(readFileSync(filePath, "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  const server = settings.mcpServers?.[serverName];
  if (!server) return;
  delete server.oauth;
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, filePath);
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
}

/** The transport of a remote server, signed in with its saved OAuth state. */
export function remoteTransport(
  server: McpServer,
  authProvider: OAuthClientProvider | undefined,
) {
  const transport = server.transport;
  if (transport.type === "stdio")
    throw new Error(`MCP server "${server.name}" is not a remote server.`);
  const options = {
    ...(authProvider ? { authProvider } : {}),
    requestInit: { headers: transport.headers ?? {} },
  };
  return transport.type === "sse"
    ? new SSEClientTransport(new URL(transport.url), options)
    : new StreamableHTTPClientTransport(new URL(transport.url), options);
}

/**
 * Signs in to a remote server: opens its authorization page and waits for
 * the redirect, then checks the connection lists its tools.
 */
export async function authorizeMcpOAuth(input: {
  filePath: string;
  openUrl(url: string): Promise<void>;
  serverName: string;
  signal?: AbortSignal;
}) {
  const found = (await configuredMcpServers(input.filePath)).find(
    ({ server }) => server.name === input.serverName,
  );
  if (!found)
    throw new Error(`MCP server "${input.serverName}" is not configured.`);
  const server = found.server;
  if (server.transport.type === "stdio")
    throw new Error(
      `MCP server "${server.name}" uses stdio transport and does not support OAuth browser flow.`,
    );
  if (
    Object.keys(server.transport.headers ?? {}).some(
      (name) => name.toLowerCase() === "authorization",
    )
  )
    throw new Error(
      `MCP server "${server.name}" has a static Authorization header. Remove it before starting OAuth.`,
    );
  const callback = await listenForCallback(input.signal);
  try {
    const provider = new SettingsOAuthProvider({
      serverName: server.name,
      path: input.filePath,
      redirectUrl: callback.url,
      onAuthorizationUrl: (url) => input.openUrl(url.toString()),
    });
    const connect = async () => {
      const client = new Client({ name: "Blame", version: "1.0.0" });
      const transport = remoteTransport(server, provider);
      await client.connect(transport);
      return { client, transport };
    };
    try {
      const { client } = await connect();
      await client.listTools();
      await client.close();
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const code = await callback.code;
      const transport = remoteTransport(server, provider) as {
        finishAuth(code: string): Promise<void>;
      };
      await transport.finishAuth(code);
      const { client } = await connect();
      await client.listTools();
      await client.close();
    }
    await updateMcpOAuthState(
      server.name,
      (state) => ({
        ...state,
        lastError: undefined,
        authorizationRequired: false,
      }),
      input.filePath,
    );
    return { serverName: server.name, authorized: true };
  } catch (error) {
    await updateMcpOAuthState(
      server.name,
      (state) => ({
        ...state,
        lastError: error instanceof Error ? error.message : String(error),
      }),
      input.filePath,
    ).catch(() => undefined);
    throw error;
  } finally {
    callback.close();
  }
}

/** A loopback server for the OAuth redirect, on the first free port. */
async function listenForCallback(signal?: AbortSignal) {
  let settle: { resolve(code: string): void; reject(error: Error): void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => undefined);
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== callbackPath) {
      response.writeHead(404).end();
      return;
    }
    const received = url.searchParams.get("code");
    const failure = url.searchParams.get("error");
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        received
          ? "<p>Blame is signed in to this MCP server. You can close this tab.</p>"
          : "<p>The sign-in did not finish. You can close this tab and try again from Blame.</p>",
      );
    if (received) settle.resolve(received);
    else
      settle.reject(
        new Error(
          `The MCP server refused the sign-in: ${failure ?? "no code"}.`,
        ),
      );
  });
  let port: number | undefined;
  for (const candidate of callbackPorts) {
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (listening) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error("Unable to bind local MCP OAuth callback server.");
  const timer = setTimeout(
    () =>
      settle.reject(new Error("The MCP sign-in took longer than 5 minutes.")),
    authorizationTimeoutMs,
  );
  const onAbort = () =>
    settle.reject(new Error("The MCP sign-in was cancelled."));
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    url: `http://127.0.0.1:${port}${callbackPath}`,
    code,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
      server.closeAllConnections();
    },
  };
}
