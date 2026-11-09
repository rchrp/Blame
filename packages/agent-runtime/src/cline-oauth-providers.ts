import type {
  OAuthCredentials as ClineOAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@cline/sdk";

import type { OAuthCredentials } from "./types.js";

type ClineSdk = typeof import("@cline/sdk");

export function forceOAuthRefresh(providerId: string) {
  return providerId === "openai-codex";
}

export function supportedClineOAuthProvider(providerId: string) {
  return (
    providerId === "openai-codex" ||
    providerId === "cline" ||
    providerId === "opencode" ||
    providerId === "oca"
  );
}

export function openAICodexOAuthProvider(
  sdk: ClineSdk,
): OAuthProviderInterface {
  return {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro (ChatGPT Subscription)",
    usesCallbackServer: true,
    login: (callbacks: OAuthLoginCallbacks) => sdk.loginOpenAICodex(callbacks),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshOpenAICodexToken(credentials.refresh, credentials),
    getApiKey: (credentials: ClineOAuthCredentials) => credentials.access,
  };
}

export function clineOAuthProvider(
  sdk: ClineSdk,
  providerId: "cline" | "opencode",
): OAuthProviderInterface {
  const provider = providerId === "opencode" ? providerId : undefined;
  return {
    id: providerId,
    name: providerId === "cline" ? "Cline Account" : "OpenCode",
    usesCallbackServer: false,
    login: (callbacks: OAuthLoginCallbacks) =>
      sdk.loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        callbacks,
        provider,
      }),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshClineToken(credentials, {
        apiBaseUrl: "https://api.cline.bot",
        provider,
      }),
    getApiKey: clineOAuthApiKey,
  };
}

export function ocaOAuthProvider(sdk: ClineSdk): OAuthProviderInterface {
  return {
    id: "oca",
    name: "Oracle Code Assist",
    usesCallbackServer: true,
    login: (callbacks: OAuthLoginCallbacks) => sdk.loginOcaOAuth({ callbacks }),
    refreshToken: (credentials: ClineOAuthCredentials) =>
      sdk.refreshOcaToken(credentials),
    getApiKey: (credentials: ClineOAuthCredentials) => credentials.access,
  };
}

function clineOAuthApiKey(credentials: ClineOAuthCredentials) {
  if (credentials.access.startsWith("workos:")) return credentials.access;
  return `workos:${credentials.access}`;
}

export function toBlameOAuthCredentials(
  credentials: ClineOAuthCredentials,
): OAuthCredentials {
  return {
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    accountId: credentials.accountId,
    email: credentials.email,
    metadata: credentials.metadata,
  };
}
