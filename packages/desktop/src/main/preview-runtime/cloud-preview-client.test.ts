import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudPreviewRequestError,
  CloudPreviewClient,
  isBaselineSnapshotUnavailable,
  isCloudPreviewSessionId,
} from "./cloud-preview-client.ts";

test("restricts packaged cloud credentials to the official API", () => {
  assert.doesNotThrow(
    () =>
      new CloudPreviewClient(
        { token: "a".repeat(32), url: "https://api.blame.so/api/v1" },
        { packaged: true },
      ),
  );
  assert.throws(
    () =>
      new CloudPreviewClient(
        { token: "a".repeat(32), url: "https://attacker.example/api/v1" },
        { packaged: true },
      ),
    /invalid/,
  );
});

test("allows loopback development APIs without allowing arbitrary hosts", () => {
  assert.doesNotThrow(
    () =>
      new CloudPreviewClient(
        { token: "a".repeat(32), url: "http://127.0.0.1:3333/api/v1" },
        { packaged: false },
      ),
  );
  assert.throws(
    () =>
      new CloudPreviewClient(
        {
          token: "a".repeat(32),
          url: "https://staging.attacker.example/api/v1",
        },
        { packaged: false },
      ),
    /invalid/,
  );
});

test("accepts only server-issued managed preview session IDs", () => {
  assert.equal(
    isCloudPreviewSessionId("preview_bbcb1626c004cdec3aad60175f1f0cae"),
    true,
  );
  assert.equal(isCloudPreviewSessionId("preview/../../credentials"), false);
  assert.equal(isCloudPreviewSessionId("preview-not-a-server-id"), false);
});

test("resolves the canonical cloud session by user story", async (context) => {
  let requestedUrl = "";
  context.mock.method(globalThis, "fetch", async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ session: runningPreviewSession() });
  });
  const client = new CloudPreviewClient({
    token: "a".repeat(32),
    url: "http://127.0.0.1:3333/api/v1",
  });

  const result = await client.findForUserStory("story-id", "vercel-compose");

  assert.equal(result.session?.id, runningPreviewSession().id);
  assert.match(
    requestedUrl,
    /preview-sessions\?userStoryId=story-id&profile=vercel-compose$/,
  );
});

test("preserves structured provider failures for workspace recovery", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          failure: {
            code: "SOURCE_SYNC_FAILED",
            message:
              "The preview baseline expired before source synchronization.",
            providerCode: "BASELINE_SNAPSHOT_NOT_FOUND",
            retryable: true,
          },
        }),
        { status: 503 },
      ),
  );
  const client = new CloudPreviewClient({
    token: "a".repeat(32),
    url: "http://127.0.0.1:3333/api/v1",
  });

  await assert.rejects(
    () => client.get("preview_bbcb1626c004cdec3aad60175f1f0cae"),
    (error) =>
      error instanceof CloudPreviewRequestError &&
      error.status === 503 &&
      isBaselineSnapshotUnavailable(error),
  );
});

test("recovers a command whose gateway response was lost after completion", async (context) => {
  const methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1)
      return new Response("Bad Gateway", { status: 502 });
    return jsonResponse(runningPreviewSession());
  });
  const client = cloudClientWithImmediateRecovery();

  const session = await client.command(
    "preview_bbcb1626c004cdec3aad60175f1f0cae",
    { type: "start-services", configurationId: "web" },
    "start-operation",
  );

  assert.equal(session.state.preview, "ready");
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("replays an ambiguous command with the same idempotency key", async (context) => {
  const requests: Array<{ body?: string; method: string }> = [];
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push({
      body: String(init?.body ?? ""),
      method: init?.method ?? "GET",
    });
    if (requests.length === 1)
      return new Response("Bad Gateway", { status: 502 });
    if (requests.length === 2) {
      return jsonResponse({
        ...runningPreviewSession(),
        state: {
          ...runningPreviewSession().state,
          engine: "starting",
          preview: "opening",
        },
      });
    }
    return jsonResponse(runningPreviewSession());
  });
  const client = cloudClientWithImmediateRecovery();

  await client.command(
    "preview_bbcb1626c004cdec3aad60175f1f0cae",
    { type: "start-services", configurationId: "web" },
    "start-operation",
  );

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "GET", "POST"],
  );
  assert.equal(
    JSON.parse(requests[0]!.body!).operationId,
    JSON.parse(requests[2]!.body!).operationId,
  );
});

test("does not mistake a ready previous selection for a completed command", async (context) => {
  const methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1) {
      return new Response("Bad Gateway", { status: 502 });
    }
    if (methods.length === 2) {
      return jsonResponse({
        ...runningPreviewSession(),
        selection: { configurationId: "previous" },
      });
    }
    return jsonResponse(runningPreviewSession());
  });
  const client = cloudClientWithImmediateRecovery();

  const session = await client.command(
    "preview_bbcb1626c004cdec3aad60175f1f0cae",
    { type: "start-services", configurationId: "web" },
    "start-operation",
  );

  assert.equal(session.selection.configurationId, "web");
  assert.deepEqual(methods, ["POST", "GET", "POST"]);
});

test("recovers a command that collided with another session operation", async (context) => {
  const methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1) {
      return new Response(
        JSON.stringify({
          failure: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Another preview operation is still finishing.",
            providerCode: "SESSION_LOCK_TIMEOUT",
            retryable: true,
          },
        }),
        { status: 503 },
      );
    }
    return jsonResponse(runningPreviewSession());
  });
  const client = cloudClientWithImmediateRecovery();

  const session = await client.command(
    "preview_bbcb1626c004cdec3aad60175f1f0cae",
    { type: "start-services", configurationId: "web" },
    "start-operation",
  );

  assert.equal(session.state.preview, "ready");
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("aborts an in-flight event stream when its subscriber leaves", async (context) => {
  let observedSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    observedSignal = init?.signal ?? undefined;
    markStarted?.();
    return await new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(observedSignal?.reason),
        { once: true },
      );
    });
  });
  const client = cloudClientWithImmediateRecovery();
  const controller = new AbortController();
  const iterator = client
    .events(
      "preview_bbcb1626c004cdec3aad60175f1f0cae",
      undefined,
      controller.signal,
    )
    [Symbol.asyncIterator]();

  const pending = iterator.next();
  await started;
  controller.abort();

  await assert.rejects(pending, (error) => error instanceof DOMException);
  assert.equal(observedSignal, controller.signal);
});

test("parses CRLF event streams and resumes from their cursor", async (context) => {
  const requestedUrls: string[] = [];
  context.mock.method(globalThis, "fetch", async (url) => {
    requestedUrls.push(String(url));
    return new Response(
      `id: cursor-2\r\ndata: ${JSON.stringify({
        cursor: "cursor-2",
        type: "session.updated",
      })}\r\n\r\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const client = cloudClientWithImmediateRecovery();
  const controller = new AbortController();
  const iterator = client
    .events(
      "preview_bbcb1626c004cdec3aad60175f1f0cae",
      undefined,
      controller.signal,
    )
    [Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value?.cursor, "cursor-2");
  controller.abort();
  await assert.rejects(
    iterator.next(),
    (error) => error instanceof DOMException,
  );
  assert.equal(requestedUrls.length, 1);
});

test("prepares an upload without serializing workspace bytes", async (context) => {
  let requestBody: unknown;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        artifactId: "artifact-id",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        headers: {},
        url: "https://storage.example/artifact",
      }),
      { status: 200 },
    );
  });
  const client = new CloudPreviewClient({
    token: "a".repeat(32),
    url: "http://127.0.0.1:3333/api/v1",
  });
  await client.prepareSourceUpload("preview_bbcb1626c004cdec3aad60175f1f0cae", {
    content: Buffer.alloc(1024 * 1024),
    sha256: "b".repeat(64),
    size: 1024 * 1024,
    sourceRevision: "c".repeat(40),
  });
  assert.deepEqual(requestBody, {
    action: "prepare",
    sha256: "b".repeat(64),
    size: 1024 * 1024,
    sourceRevision: "c".repeat(40),
  });
});

test("normalizes stored manifests before creating a cloud session", async (context) => {
  let requestBody: {
    sourceMetadata?: {
      sourceRevision?: string;
      workspaceHash?: string;
    };
    previewManifest?: {
      services?: Array<{ id?: string; command?: string; dependsOn?: string[] }>;
    };
    environment?: unknown;
  } = {};
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({}), { status: 200 });
  });
  const client = new CloudPreviewClient({
    token: "a".repeat(32),
    url: "http://127.0.0.1:3333/api/v1",
  });

  await client.create({
    userStoryId: "story-id",
    profile: "vercel-compose",
    cloudUploadConsentAt: new Date().toISOString(),
    operationId: "operation-id",
    sourceMetadata: {
      sourceRevision: "a".repeat(40),
      sanitizedTreeHash: "b".repeat(64),
      lockfileHash: "c".repeat(64),
      workspaceHash: "d".repeat(64),
    },
    previewManifest: {
      confidence: "high",
      project: {
        root: ".",
        detectedStack: ["nextjs", "pnpm"],
        confidence: "high",
      },
      setup: [],
      services: [
        {
          id: "api",
          kind: "worker",
          container: { image: "node:22-bookworm" },
          command: "node api.js",
          endpoints: [{ id: "http", protocol: "http", port: 3333 }],
        },
        {
          id: "vitrine",
          kind: "preview",
          container: { image: "node:22-bookworm" },
          command:
            "corepack pnpm --filter @blame/vitrine dev -- --hostname 0.0.0.0",
          dependsOn: ["api"],
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
            },
          ],
          bindings: [
            {
              target: { type: "environment", key: "NEXT_PUBLIC_API_URL" },
              source: { service: "api", endpoint: "http" },
              exposure: "browser",
              format: "url",
            },
          ],
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    },
    environment: {
      variables: { api: { STRIPE_SECRET_KEY: "sk_test_1" } },
      files: [],
    },
  });

  // The variables travel with the request, apart from the manifest.
  assert.deepEqual(requestBody.environment, {
    variables: { api: { STRIPE_SECRET_KEY: "sk_test_1" } },
    files: [],
  });
  assert.doesNotMatch(JSON.stringify(requestBody.previewManifest), /sk_test_1/);
  const vitrine = requestBody.previewManifest?.services?.find(
    ({ id }) => id === "vitrine",
  );
  assert.match(vitrine?.command ?? "", /dev --hostname 0\.0\.0\.0/);
  assert.deepEqual(vitrine?.dependsOn, []);
  assert.equal(requestBody.sourceMetadata?.workspaceHash, "d".repeat(64));
});

function cloudClientWithImmediateRecovery() {
  return new CloudPreviewClient(
    {
      token: "a".repeat(32),
      url: "http://127.0.0.1:3333/api/v1",
    },
    { commandRecovery: { pollAttempts: 1, pollIntervalMs: 0 } },
  );
}

function runningPreviewSession() {
  return {
    id: "preview_bbcb1626c004cdec3aad60175f1f0cae",
    desired: {
      host: "active",
      services: "running",
      preview: "open",
      agent: "idle",
    },
    state: {
      host: "running",
      engine: "running",
      preview: "ready",
      agent: "idle",
      sync: "clean",
    },
    selection: { configurationId: "web" },
    endpointMap: {
      revision: 1,
      primaryRouteId: "route",
      primaryPublicUrl: "https://preview.example.test",
      routes: [],
      supportsWebSocket: true,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
