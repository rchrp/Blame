import type { ModelInfo } from "@cline/llms";
import type {
  ApiConnection,
  DeleteProviderCredentialInput,
  OAuthCredentials,
  ProviderCredentialSummary,
  ProviderListResponse,
  SaveOAuthCredentialInput,
  SaveProviderCredentialInput,
} from "./types.js";
import type {
  ProjectMemoryCandidate,
  ProjectMemoryRecord,
} from "./harness/project-memory.js";

type ApiResponse<T> = {
  data: T;
};

type ResolvedCredential = {
  id: string;
  providerId: string;
  label: string;
  authMethod?: "api-key" | "oauth";
  apiKey: string;
  baseUrl: string | null;
  modelIds?: string[];
  oauthCredentials?: OAuthCredentials | null;
};

export async function listProviders(connection: ApiConnection) {
  const [catalog, credentials] = await Promise.all([
    request<Pick<ProviderListResponse, "all" | "default" | "recommendations">>(
      connection,
      "/providers/catalog",
    ),
    request<unknown>(connection, "/providers/credentials"),
  ]);
  const credentialList = normalizeCredentials(credentials);
  const connected: string[] = Array.from(
    new Set(credentialList.map((credential) => credential.providerId)),
  );
  return {
    ...catalog,
    connected,
    credentials: credentialList,
  } satisfies ProviderListResponse;
}

/** Complete Cline metadata for a model the bundled SDK may not know yet. */
export async function fetchCatalogModel(
  connection: ApiConnection,
  providerId: string,
  modelId: string,
) {
  const query = new URLSearchParams({ providerId, modelId });
  return request<ModelInfo>(connection, `/providers/catalog/model?${query}`, {
    signal: AbortSignal.timeout(2_000),
  });
}

export function saveProviderCredential(
  connection: ApiConnection,
  input: SaveProviderCredentialInput,
) {
  return request<ProviderCredentialSummary>(
    connection,
    "/providers/credentials",
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

export function saveOAuthCredential(
  connection: ApiConnection,
  input: SaveOAuthCredentialInput,
) {
  return request<ProviderCredentialSummary>(
    connection,
    "/providers/credentials/oauth",
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

export function deleteProviderCredential(
  connection: ApiConnection,
  input: DeleteProviderCredentialInput,
) {
  return request<void>(connection, `/providers/credentials/${input.id}`, {
    method: "DELETE",
  });
}

export function resolveProviderCredential(
  connection: ApiConnection,
  input: { providerId: string; label?: string },
) {
  return request<ResolvedCredential>(
    connection,
    "/providers/credentials/resolve",
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

export function listProjectMemories(
  connection: ApiConnection,
  projectId: string,
) {
  return request<ProjectMemoryRecord[]>(
    connection,
    `/projects/${encodeURIComponent(projectId)}/agent-memories`,
    { signal: AbortSignal.timeout(1_500) },
  );
}

export function saveProjectMemory(
  connection: ApiConnection,
  projectId: string,
  candidate: ProjectMemoryCandidate,
) {
  return request<ProjectMemoryRecord>(
    connection,
    `/projects/${encodeURIComponent(projectId)}/agent-memories`,
    {
      body: JSON.stringify(candidate),
      method: "POST",
      signal: AbortSignal.timeout(1_500),
    },
  );
}

async function request<T>(
  connection: ApiConnection,
  path: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const authorization = authorizationHeader(connection);
  if (authorization) headers.set("Authorization", authorization);

  const response = await fetch(`${connection.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) throw new Error(await responseMessage(response));
  if (response.status === 204) return undefined as T;
  const json = (await response.json()) as ApiResponse<T> | T;
  return transformerValue(responseData(json)) as T;
}

function authorizationHeader(connection: ApiConnection) {
  if (!connection.token) return undefined;
  return `Bearer ${connection.token}`;
}

async function responseMessage(response: Response) {
  try {
    const body = await response.json();
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    return `Request failed with status ${response.status}`;
  }
  return `Request failed with status ${response.status}`;
}

function responseData<T>(value: ApiResponse<T> | T) {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function transformerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(transformerValue);
  if (!isRecord(value)) return value;
  if ("data" in value) return transformerValue(value.data);
  if (!Array.isArray(value.transformerData)) return value;
  return transformerValue(value.transformerData[0]);
}

function normalizeCredentials(value: unknown) {
  if (!Array.isArray(value)) return [];
  const credentials: ProviderCredentialSummary[] = [];
  for (const item of value) {
    const credential = normalizeCredential(item);
    if (credential) credentials.push(credential);
  }
  return credentials;
}

function normalizeCredential(
  value: unknown,
): ProviderCredentialSummary | undefined {
  const credential = transformerValue(value);
  if (!isRecord(credential)) return undefined;

  const normalized = {
    id: stringField(credential, "id"),
    userId: stringField(credential, "userId", "user_id"),
    providerId: stringField(credential, "providerId", "provider_id"),
    label: stringField(credential, "label"),
    authMethod: authMethodField(credential),
    baseUrl: nullableStringField(credential, "baseUrl", "base_url"),
    modelIds: stringArrayField(credential, "modelIds", "model_ids"),
    accountId: nullableStringField(credential, "accountId", "account_id"),
    expiresAt: nullableStringField(credential, "expiresAt", "expires_at"),
    createdAt: stringField(credential, "createdAt", "created_at"),
    updatedAt: nullableStringField(credential, "updatedAt", "updated_at"),
  };
  if (!normalized.id || !normalized.providerId) return undefined;
  return normalized;
}

function stringField(value: Record<string, unknown>, ...keys: string[]) {
  const field = firstField(value, keys);
  return typeof field === "string" ? field : "";
}

function stringArrayField(value: Record<string, unknown>, ...keys: string[]) {
  const field = firstField(value, keys);
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string")
    : [];
}

function nullableStringField(
  value: Record<string, unknown>,
  ...keys: string[]
) {
  const field = firstField(value, keys);
  return typeof field === "string" ? field : null;
}

function authMethodField(value: Record<string, unknown>): "api-key" | "oauth" {
  const field = stringField(value, "authMethod", "auth_method");
  return field === "oauth" ? "oauth" : "api-key";
}

function firstField(value: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => value[key]).find((field) => field !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
