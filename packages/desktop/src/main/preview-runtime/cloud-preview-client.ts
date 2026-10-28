import type {
  PreviewLogEvent,
  PreviewSessionBackend,
  PreviewSessionCommand,
  PreviewSessionEvent,
  PreviewSessionView,
} from "@blame/preview-runtime";
import { parsePreviewManifest } from "@blame/agent-runtime";
import type { DesktopBridgeGrant } from "../preview-browser/preview-bridge-grant";

export type { DesktopBridgeGrant } from "../preview-browser/preview-bridge-grant";

export type CloudApiConnection = { token: string; url: string };
type CloudPreviewClientOptions = { packaged?: boolean };
type CloudCommandRecoveryOptions = {
  pollAttempts?: number;
  pollIntervalMs?: number;
};

export type CloudPreviewFailure = {
  code?: string;
  message?: string;
  providerCode?: string;
  retryable?: boolean;
};

export class CloudPreviewRequestError extends Error {
  readonly status: number;
  readonly failure: CloudPreviewFailure | undefined;

  constructor(
    status: number,
    failure: CloudPreviewFailure | undefined,
    responseBody: string,
  ) {
    super(
      `Cloud preview request failed (${status}): ${responseBody.slice(0, 500)}`,
    );
    this.name = "CloudPreviewRequestError";
    this.status = status;
    this.failure = failure;
  }
}

export function isBaselineSnapshotUnavailable(error: unknown) {
  return (
    error instanceof CloudPreviewRequestError &&
    error.failure?.providerCode === "BASELINE_SNAPSHOT_NOT_FOUND"
  );
}

export type CloudManagedPreviewCreateInput = {
  userStoryId: string;
  profile: "vercel-compose";
  previewManifest: unknown;
  cloudUploadConsentAt: string;
  operationId: string;
  sourceRevision?: string;
  sourceMetadata?: {
    sourceRevision: string;
    sanitizedTreeHash: string;
    lockfileHash: string;
    workspaceHash: string;
  };
  resourceSize?: { vcpus: number; memoryGb: number };
};
export class CloudPreviewClient implements PreviewSessionBackend<CloudManagedPreviewCreateInput> {
  private readonly connection: CloudApiConnection;
  private readonly commandRecovery: Required<CloudCommandRecoveryOptions>;

  constructor(
    connection: CloudApiConnection,
    options: CloudPreviewClientOptions & {
      commandRecovery?: CloudCommandRecoveryOptions;
    } = {},
  ) {
    if (!allowedCloudApiBaseUrl(connection.url, options.packaged ?? false))
      throw new Error("Cloud API connection is invalid");
    if (!connection.token || connection.token.length > 16_384)
      throw new Error("Cloud API token is invalid");
    this.connection = connection;
    this.commandRecovery = {
      pollAttempts: options.commandRecovery?.pollAttempts ?? 6,
      pollIntervalMs: options.commandRecovery?.pollIntervalMs ?? 1_000,
    };
  }

  create(input: CloudManagedPreviewCreateInput) {
    return this.request<PreviewSessionView>("/preview-sessions", {
      method: "POST",
      headers: { "idempotency-key": input.operationId },
      body: {
        userStoryId: input.userStoryId,
        profile: input.profile,
        previewManifest: parsePreviewManifest(input.previewManifest),
        cloudUploadConsentAt: input.cloudUploadConsentAt,
        operationId: input.operationId,
        sourceRevision: input.sourceRevision,
        sourceMetadata: input.sourceMetadata,
        resourceSize: input.resourceSize,
      },
    });
  }

  async command(
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string,
  ) {
    const request = () =>
      this.request<PreviewSessionView>(
        `/preview-sessions/${encoded(sessionId)}/actions`,
        {
          method: "POST",
          headers: { "idempotency-key": operationId },
          body: { command, operationId },
        },
      );
    try {
      return await request();
    } catch (error) {
      if (!recoverableCommandFailure(error)) throw error;
      const recovered = await this.recoverAmbiguousCommand(sessionId, command);
      if (recovered) return recovered;
      try {
        return await request();
      } catch (retryError) {
        if (!recoverableCommandFailure(retryError)) throw retryError;
        const retried = await this.recoverAmbiguousCommand(sessionId, command);
        if (retried) return retried;
        throw retryError;
      }
    }
  }

  private async recoverAmbiguousCommand(
    sessionId: string,
    command: PreviewSessionCommand,
  ) {
    for (
      let attempt = 0;
      attempt < this.commandRecovery.pollAttempts;
      attempt += 1
    ) {
      if (attempt > 0) await delay(this.commandRecovery.pollIntervalMs);
      try {
        const session = await this.get(sessionId);
        if (commandReachedState(session, command)) return session;
      } catch {
        // The API gateway can still be recovering from the ambiguous request.
      }
    }
    return undefined;
  }

  get(sessionId: string) {
    return this.request<PreviewSessionView>(
      `/preview-sessions/${encoded(sessionId)}`,
    );
  }

  findForUserStory(userStoryId: string, profile: "vercel-compose") {
    const query = new URLSearchParams({ userStoryId, profile });
    return this.request<{ session: PreviewSessionView | null }>(
      `/preview-sessions?${query.toString()}`,
    );
  }

  async *events(
    sessionId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): AsyncIterable<PreviewSessionEvent> {
    let nextCursor = cursor;
    while (true) {
      signal?.throwIfAborted();
      const query = nextCursor
        ? `?cursor=${encodeURIComponent(nextCursor)}`
        : "";
      const response = await this.fetch(
        `/preview-sessions/${encoded(sessionId)}/events${query}`,
        {
          headers: { Accept: "text/event-stream" },
          signal,
        },
      );
      if (!response.ok || !response.body) throw await cloudError(response);
      for await (const event of parseEventStream(response.body)) {
        const value = JSON.parse(event.data) as PreviewSessionEvent;
        nextCursor = event.id || value.cursor;
        yield value;
      }
      await delay(250, signal);
    }
  }

  async *logs(
    sessionId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): AsyncIterable<PreviewLogEvent> {
    let nextCursor = cursor;
    while (true) {
      signal?.throwIfAborted();
      const query = nextCursor
        ? `?cursor=${encodeURIComponent(nextCursor)}`
        : "";
      const response = await this.fetch(
        `/preview-sessions/${encoded(sessionId)}/logs${query}`,
        { headers: { Accept: "text/event-stream" }, signal },
      );
      if (!response.ok || !response.body) throw await cloudError(response);
      for await (const event of parseEventStream(response.body)) {
        const value = JSON.parse(event.data) as PreviewLogEvent;
        nextCursor = event.id || String(value.sequence);
        yield value;
      }
      await delay(250, signal);
    }
  }

  bridgeGrant(sessionId: string) {
    return this.request<DesktopBridgeGrant>(
      `/preview-sessions/${encoded(sessionId)}/bridge-grant`,
      {
        method: "POST",
        body: {},
      },
    );
  }

  accessTicket(sessionId: string, routeId?: string) {
    return this.request<
      import("./external-preview-launcher").ExternalPreviewTicket
    >(`/preview-sessions/${encoded(sessionId)}/access-ticket`, {
      method: "POST",
      body: { routeId },
    });
  }

  surfaceAction(
    sessionId: string,
    serviceId: string,
    args: Record<string, unknown>,
  ) {
    return this.request<import("@blame/preview-runtime").ExecResult>(
      `/preview-sessions/${encoded(sessionId)}/surface-action`,
      { method: "POST", body: { serviceId, arguments: args } },
    );
  }

  prepareSourceUpload(
    sessionId: string,
    artifact: {
      sha256: string;
      size: number;
      sourceRevision: string;
      sanitizedTreeHash?: string;
      lockfileHash?: string;
      workspaceHash?: string;
      baseHash?: string;
      mode?: "full" | "delta";
    },
  ) {
    return this.request<UploadTarget>(
      `/preview-sessions/${encoded(sessionId)}/source/import`,
      {
        method: "POST",
        body: {
          action: "prepare",
          sha256: artifact.sha256,
          size: artifact.size,
          sourceRevision: artifact.sourceRevision,
          sanitizedTreeHash: artifact.sanitizedTreeHash,
          lockfileHash: artifact.lockfileHash,
          workspaceHash: artifact.workspaceHash,
          baseHash: artifact.baseHash,
          mode: artifact.mode,
        },
      },
    );
  }

  negotiateSource(
    sessionId: string,
    metadata: {
      sourceRevision: string;
      sanitizedTreeHash: string;
      lockfileHash: string;
      workspaceHash: string;
    },
  ) {
    return this.request<{
      baseline?: UploadTarget["baseline"];
      unchanged: boolean;
      session: PreviewSessionView;
    }>(`/preview-sessions/${encoded(sessionId)}/source/import`, {
      method: "POST",
      body: { action: "negotiate", ...metadata },
    });
  }

  applySourceUpload(
    sessionId: string,
    artifactId: string,
    baselineId?: string,
  ) {
    return this.request<PreviewSessionView>(
      `/preview-sessions/${encoded(sessionId)}/source/import`,
      {
        method: "POST",
        body: { action: "apply", artifactId, baselineId },
      },
    );
  }

  exportSourceDelta(sessionId: string) {
    return this.request<DeltaDownload>(
      `/preview-sessions/${encoded(sessionId)}/source/export`,
      {
        method: "POST",
        body: {},
      },
    );
  }

  private async request<T>(path: string, input: RequestInput = {}) {
    const response = await this.fetch(path, {
      method: input.method,
      headers: input.headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    if (!response.ok) throw await cloudError(response);
    return response.json() as Promise<T>;
  }

  private fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.connection.token}`);
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    return fetch(
      new URL(apiPath(path), normalizedBaseUrl(this.connection.url)),
      {
        ...init,
        headers,
        redirect: "error",
      },
    );
  }
}
export function allowedCloudApiBaseUrl(value: string, packaged: boolean) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return false;
    const apiPath = url.pathname.replace(/\/$/, "");
    if (url.origin === "https://api.blame.so" && apiPath === "/api/v1") {
      return true;
    }
    return (
      !packaged &&
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      apiPath === "/api/v1"
    );
  } catch {
    return false;
  }
}

export type UploadTarget = {
  artifactId: string;
  expiresAt: string;
  headers: Record<string, string>;
  url: string;
  baseline?: {
    id: string;
    fingerprint: string;
    status: "building" | "ready" | "failed" | "expired" | "deleting";
    baseRevision: string;
    match?: "exact" | "cache";
    providerSnapshotId?: string;
  };
};

export type DeltaDownload = {
  artifactId: string;
  sha256: string;
  size: number;
  baseHash: string | null;
  finalHash: string | null;
  generation: number | null;
  revision: string | null;
  discardConfirmationId: string;
  url: string;
};

type RequestInput = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

function normalizedBaseUrl(value: string) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function apiPath(value: string) {
  return value.replace(/^\//, "");
}

function encoded(value: string) {
  if (!isCloudPreviewSessionId(value))
    throw new Error("Preview session ID is invalid");
  return encodeURIComponent(value);
}

export function isCloudPreviewSessionId(value: unknown): value is string {
  return typeof value === "string" && /^preview_[a-f0-9]{32}$/.test(value);
}

async function cloudError(response: Response) {
  const body = await response.text().catch(() => "");
  let failure: CloudPreviewFailure | undefined;
  try {
    const parsed = JSON.parse(body) as { failure?: unknown };
    if (parsed.failure && typeof parsed.failure === "object") {
      failure = parsed.failure as CloudPreviewFailure;
    }
  } catch {}
  return new CloudPreviewRequestError(response.status, failure, body);
}

function recoverableCommandFailure(error: unknown) {
  return (
    error instanceof CloudPreviewRequestError &&
    (([502, 504].includes(error.status) && !error.failure) ||
      (error.status === 503 &&
        error.failure?.providerCode === "SESSION_LOCK_TIMEOUT" &&
        error.failure.retryable !== false))
  );
}

function commandReachedState(
  session: PreviewSessionView,
  command: PreviewSessionCommand,
) {
  switch (command.type) {
    case "start-services":
      return (
        selectionMatchesCommand(session, command) &&
        session.desired.services === "running" &&
        session.state.engine === "running" &&
        session.state.preview === "ready" &&
        Boolean(session.endpointMap)
      );
    case "stop-services":
      return (
        session.desired.services === "stopped" &&
        ["idle", "stopped"].includes(session.state.engine)
      );
    case "resume-host":
      return (
        session.desired.host === "active" && session.state.host === "running"
      );
    case "suspend-host":
      return session.state.host === "suspended";
    case "destroy-host":
      return session.state.host === "destroyed";
    case "start-agent":
      return session.state.agent === "running";
    case "stop-agent":
      return session.state.agent === "idle";
    case "report-sync-conflict":
      return session.state.sync === "conflict";
    case "ack-local-sync":
      return session.lastAppliedLocalRevision === command.deltaRevision;
  }
}

function selectionMatchesCommand(
  session: PreviewSessionView,
  command: Extract<PreviewSessionCommand, { type: "start-services" }>,
) {
  if (session.selection?.configurationId !== command.configurationId) {
    return false;
  }
  if (!sameOptionalSet(session.selection.serviceIds, command.serviceIds)) {
    return false;
  }
  return (
    session.selection.primaryRoute?.serviceId ===
      command.primaryRoute?.serviceId &&
    session.selection.primaryRoute?.endpointId ===
      command.primaryRoute?.endpointId
  );
}

function sameOptionalSet(left?: string[], right?: string[]) {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function* parseEventStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const block = buffer.slice(0, boundary.index).replaceAll("\r", "");
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        const id = block
          .split("\n")
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trim();
        if (data) yield { data, id };
        boundary = buffer.match(/\r?\n\r?\n/);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
