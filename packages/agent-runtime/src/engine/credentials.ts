// Answers `host/credential` from the user's provider credentials, which the
// API keeps (the same ones the provider settings show). The engine holds
// what it is given in memory only, and asks again when a provider refuses it.

import { execFile } from "node:child_process";
import type { Credential, HostParamsOf } from "@blame/engine-client";
import {
  ClaudeCodeBridge,
  claudeCodeStateDirectory,
} from "../claude-code/claude-code-bridge.js";
import type { ClaudeCodeBridgeHandle } from "../claude-code/claude-code-bridge-client.js";
import {
  resolveProviderCredential,
  saveOAuthCredential,
} from "../cloud-api.js";
import type { ApiConnection, OAuthCredentials } from "../types.js";

type ResolvedCredential = Awaited<ReturnType<typeof resolveProviderCredential>>;

/** The tokens `blame-engine auth chatgpt refresh` prints. */
type ChatGptTokens = {
  access_token: string;
  refresh_token: string;
  account_id?: string;
  expires_at_s: number;
};

export type CredentialServices = {
  connection(): ApiConnection | undefined;
  /** The credential label the session's model was chosen with, if any. */
  label?(session: string, provider: string): string | undefined;
  /** Refreshes ChatGPT tokens; by default with the engine binary. */
  refreshChatGpt?(refreshToken: string): Promise<ChatGptTokens>;
  /** The Claude Code bridge; by default the one every Blame process shares. */
  claudeCodeBridge?(): Promise<ClaudeCodeBridgeHandle>;
};

// A ChatGPT token this close to its expiry is refreshed before it is used.
const refreshMarginMs = 5 * 60_000;

export class CredentialResolver {
  private bridge: Promise<ClaudeCodeBridgeHandle> | undefined;
  /** The ChatGPT token last handed to the running engine. */
  private handedChatGpt: string | undefined;
  private readonly services: CredentialServices;
  private readonly engineBinary: string;

  constructor(services: CredentialServices, engineBinary: string) {
    this.services = services;
    this.engineBinary = engineBinary;
  }

  /** A new engine starts with nothing: it may ask again without a refusal. */
  engineRestarted() {
    this.handedChatGpt = undefined;
  }

  async resolve(params: HostParamsOf<"host/credential">): Promise<Credential> {
    const provider = params.provider;
    if (provider === "claude-code") return this.claudeCode(params.session);
    const connection = this.services.connection();
    if (!connection) return { type: "missing" };
    let credential: ResolvedCredential;
    try {
      credential = await resolveProviderCredential(connection, {
        providerId: provider,
        label: this.services.label?.(params.session, provider),
      });
    } catch {
      // No credential for this provider: the turn fails with an
      // authentication error the person can act on.
      return { type: "missing" };
    }
    if (params.provider === "chatgpt")
      return this.chatGpt(connection, credential);
    return {
      type: "api_key",
      key: credential.apiKey,
      ...(credential.baseUrl ? { base_url: credential.baseUrl } : {}),
    };
  }

  private async chatGpt(
    connection: ApiConnection,
    credential: ResolvedCredential,
  ): Promise<Credential> {
    let tokens = credential.oauthCredentials;
    if (!tokens) return { type: "missing" };
    // The engine asks for ChatGPT once, then again only when the token
    // was refused: the same token asked twice is a refused one.
    const refused = this.handedChatGpt === tokens.access;
    if (refused || tokens.expires < Date.now() + refreshMarginMs)
      tokens = await this.refreshChatGpt(connection, credential, tokens);
    this.handedChatGpt = tokens.access;
    return {
      type: "bearer",
      token: tokens.access,
      ...(tokens.accountId ? { account: tokens.accountId } : {}),
    };
  }

  /**
   * A ChatGPT token that is good for a while yet, for reading the plan's
   * usage; `undefined` without a ChatGPT sign-in.
   */
  async chatGptToken(label?: string): Promise<OAuthCredentials | undefined> {
    const connection = this.services.connection();
    if (!connection) return undefined;
    const credential = await resolveProviderCredential(connection, {
      providerId: "chatgpt",
      label,
    }).catch(() => undefined);
    const tokens = credential?.oauthCredentials;
    if (!credential || !tokens) return undefined;
    if (tokens.expires >= Date.now() + refreshMarginMs) return tokens;
    return this.refreshChatGpt(connection, credential, tokens);
  }

  private async refreshChatGpt(
    connection: ApiConnection,
    credential: ResolvedCredential,
    tokens: OAuthCredentials,
  ): Promise<OAuthCredentials> {
    const refresh =
      this.services.refreshChatGpt ??
      ((token) => this.refreshWithEngine(token));
    let fresh: ChatGptTokens;
    try {
      fresh = await refresh(tokens.refresh);
    } catch (error) {
      // A token that still works is better than none.
      if (tokens.expires > Date.now()) return tokens;
      throw error;
    }
    const next: OAuthCredentials = {
      ...tokens,
      access: fresh.access_token,
      refresh: fresh.refresh_token,
      expires: fresh.expires_at_s * 1000,
      ...(fresh.account_id ? { accountId: fresh.account_id } : {}),
    };
    // The refresh token turns over: the new one must be kept, or the next
    // refresh fails and the person has to sign in again.
    await saveOAuthCredential(connection, {
      providerId: credential.providerId,
      label: credential.label,
      apiKey: next.access,
      oauthCredentials: next,
      baseUrl: credential.baseUrl,
    });
    return next;
  }

  private refreshWithEngine(refreshToken: string) {
    return new Promise<ChatGptTokens>((resolve, reject) => {
      const child = execFile(
        this.engineBinary,
        ["auth", "chatgpt", "refresh"],
        { timeout: 30_000 },
        (error, stdout) => {
          if (error)
            return reject(
              new Error(
                `The ChatGPT sign-in could not be refreshed: ${error.message}`,
              ),
            );
          try {
            const lines = stdout.trim().split("\n");
            resolve(JSON.parse(lines[lines.length - 1]!) as ChatGptTokens);
          } catch {
            reject(new Error("The ChatGPT sign-in could not be refreshed."));
          }
        },
      );
      child.stdin?.end(refreshToken);
    });
  }

  private async claudeCode(session: string): Promise<Credential> {
    let bridge = await this.claudeCodeBridge();
    // The process that hosted the bridge stopped: host it here.
    if (!(await bridge.reachable())) {
      this.bridge = undefined;
      bridge = await this.claudeCodeBridge();
    }
    return {
      type: "api_key",
      key: bridge.token(session),
      base_url: bridge.baseUrl("127.0.0.1"),
    };
  }

  private claudeCodeBridge() {
    this.bridge ??= (
      this.services.claudeCodeBridge?.() ??
      ClaudeCodeBridge.connect({ stateDirectory: claudeCodeStateDirectory() })
    ).catch((error: unknown) => {
      this.bridge = undefined;
      throw error;
    });
    return this.bridge;
  }

  async close() {
    const bridge = await this.bridge?.catch(() => undefined);
    this.bridge = undefined;
    await bridge?.close();
  }
}
