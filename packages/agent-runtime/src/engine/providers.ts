// The providers the person can pick from, and how they connect them: the
// engine's catalog (models.dev), the credentials the API keeps, the API's
// ranking, the ChatGPT sign-in (`blame-engine auth chatgpt login`), the
// Claude Code connection and the plans' usage. Nothing here loads Cline.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelCatalog } from "@blame/engine-client";
import { readClaudeCodeStatus } from "../claude-code/claude-code-cli.js";
import {
  deleteProviderCredential,
  fetchModelRecommendations,
  listProviderCredentials,
  resolveProviderCredential,
  saveLocalProviderCredential,
  saveOAuthCredential,
  saveProviderCredential,
  type RecommendationCandidate,
} from "../cloud-api.js";
import { readClaudeCodeUsage, readCodexUsage } from "../subscription-usage.js";
import type {
  ApiConnection,
  ProviderCredentialSummary,
  ProviderListResponse,
  SaveProviderCredentialInput,
} from "../types.js";
import type { CredentialResolver } from "./credentials.js";
import {
  emptyRecommendations,
  openAICompatibleProviderId,
  providerList,
  type CompatibleModels,
} from "./provider-list.js";

export type ProviderServices = {
  connection(): ApiConnection | undefined;
  catalog(refresh: boolean): Promise<ModelCatalog>;
  credentials: CredentialResolver;
  /** The engine binary, for the ChatGPT sign-in. */
  engineBinary: string;
  /** Opens the sign-in page in the person's browser. */
  openExternal?(url: string): Promise<void>;
  fetch?: typeof fetch;
};

// A sign-in left open in the browser this long is given up.
const signInTimeoutMs = 10 * 60_000;

export class EngineProviders {
  private readonly services: ProviderServices;

  constructor(services: ProviderServices) {
    this.services = services;
  }

  async list(refresh: boolean): Promise<ProviderListResponse> {
    const connection = this.connection();
    const [catalog, credentials] = await Promise.all([
      this.services.catalog(refresh),
      listProviderCredentials(connection),
    ]);
    const compatibleModels = await this.compatibleModels(credentials);
    const offered = providerList({ catalog, credentials, compatibleModels });
    // Ranked by the API from what the engine offers; without it the list
    // is still whole, newest first.
    const recommendations = await fetchModelRecommendations(connection, {
      connected: offered.connected,
      models: candidates(offered),
    }).catch(() => emptyRecommendations());
    return providerList({
      catalog,
      credentials,
      compatibleModels,
      recommendations,
    });
  }

  saveCredential(input: SaveProviderCredentialInput) {
    return saveProviderCredential(this.connection(), input);
  }

  async deleteCredential(id: string) {
    await deleteProviderCredential(this.connection(), { id });
    return null;
  }

  claudeCodeStatus() {
    return readClaudeCodeStatus();
  }

  /** Saves the connection once Claude Code is installed and signed in here. */
  async connectClaudeCode(label?: string) {
    const status = await readClaudeCodeStatus();
    if (!status.installed)
      throw new Error("Claude Code is not installed on this computer.");
    if (!status.loggedIn)
      throw new Error(
        "Claude Code is installed but not signed in. Run `claude`, sign in, then try again.",
      );
    const credential = await saveLocalProviderCredential(this.connection(), {
      providerId: "claude-code",
      label: label?.trim() || undefined,
      accountId: status.email ?? null,
    });
    return { credential, status };
  }

  /**
   * Signs in to ChatGPT in the browser with the engine's own sign-in and
   * keeps the tokens in the API, where the engine host reads them for every
   * conversation.
   */
  async signInChatGpt(label?: string): Promise<ProviderCredentialSummary> {
    const connection = this.connection();
    const tokens = await this.runSignIn();
    const expires = tokens.expires_at_s * 1000;
    return saveOAuthCredential(connection, {
      providerId: "chatgpt",
      label: label?.trim() || undefined,
      apiKey: tokens.access_token,
      oauthCredentials: {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires,
        ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
      },
      baseUrl: null,
    });
  }

  /** How much of a plan is used; `null` for a provider without a plan. */
  async planUsage(input: { providerId: string; credentialLabel?: string }) {
    if (input.providerId === "claude-code") return readClaudeCodeUsage();
    if (input.providerId !== "chatgpt") return null;
    const credential = await this.services.credentials.chatGptToken(
      input.credentialLabel,
    );
    if (!credential) return null;
    return readCodexUsage(credential, this.services.fetch);
  }

  private connection() {
    const connection = this.services.connection();
    if (!connection) throw new Error("Sign in to Blame to manage providers.");
    return connection;
  }

  /**
   * What each OpenAI-compatible server lists on `/models`, asked with its
   * own key. A server without that endpoint, or that does not answer within
   * a few seconds, lists nothing: the model ids saved with its credential
   * remain.
   */
  private async compatibleModels(
    credentials: ProviderCredentialSummary[],
  ): Promise<CompatibleModels> {
    const connection = this.connection();
    const servers = credentials.filter(
      (credential) =>
        credential.providerId === openAICompatibleProviderId &&
        credential.baseUrl,
    );
    const fetcher = this.services.fetch ?? fetch;
    const lists = await Promise.all(
      servers.map(async (credential) => {
        try {
          const resolved = await resolveProviderCredential(connection, {
            providerId: openAICompatibleProviderId,
            label: credential.label,
          });
          const url = `${credential.baseUrl!.replace(/\/+$/, "")}/models`;
          const response = await fetcher(url, {
            headers: resolved.apiKey
              ? { Authorization: `Bearer ${resolved.apiKey}` }
              : {},
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) return [credential.label, []] as const;
          return [credential.label, modelIds(await response.json())] as const;
        } catch {
          return [credential.label, []] as const;
        }
      }),
    );
    return Object.fromEntries(lists.filter(([, ids]) => ids.length));
  }

  private runSignIn() {
    return new Promise<SignInTokens>((resolve, reject) => {
      const child = spawn(
        this.services.engineBinary,
        ["auth", "chatgpt", "login"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("The ChatGPT sign-in was not finished in time."));
      }, signInTimeoutMs);
      timer.unref?.();
      let stderr = "";
      let tokens: SignInTokens | undefined;
      let deviceCode = false;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof message.authorize_url === "string")
          void this.services.openExternal?.(message.authorize_url);
        // The browser sign-in's ports are taken, so the engine offers a
        // code to type instead, which this dialog cannot show yet.
        if (typeof message.user_code === "string") {
          deviceCode = true;
          child.kill();
        }
        if (typeof message.access_token === "string")
          tokens = message as unknown as SignInTokens;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && tokens) return resolve(tokens);
        if (deviceCode)
          return reject(
            new Error(
              "Another ChatGPT sign-in is open (Codex or another app holds its ports). Finish or close it, then try again.",
            ),
          );
        const reason = stderr.trim().replace(/^blame-engine: /, "");
        reject(
          new Error(
            reason
              ? `The ChatGPT sign-in failed: ${reason}`
              : "The ChatGPT sign-in failed.",
          ),
        );
      });
    });
  }
}

/** What `blame-engine auth chatgpt login` prints last. */
type SignInTokens = {
  access_token: string;
  refresh_token: string;
  account_id?: string;
  expires_at_s: number;
};

function modelIds(body: unknown): string[] {
  const data =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  return data
    .map((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id
        : undefined,
    )
    .filter((id): id is string => !!id)
    .slice(0, 500);
}

/** The models the API ranks: every model of a connected provider. */
function candidates(list: ProviderListResponse): RecommendationCandidate[] {
  const connected = new Set(list.connected);
  return list.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        name: model.name,
        ...(model.releaseDate ? { releaseDate: model.releaseDate } : {}),
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead ?? null,
        },
      })),
    );
}
