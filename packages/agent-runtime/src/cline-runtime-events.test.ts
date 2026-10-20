import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentWorkspaceRevisionState } from "./harness/workspace-revisions.js";
import { previewInitializationRepairTool } from "./preview-harness-tools.js";

import type { ClineCoreStartInput, CoreSessionEvent } from "@cline/sdk";
import { ClineFreeModelLimitError, ClineNotSubscribedError } from "@cline/llms";
import { USER_REJECTED_TOOL_REASON } from "@cline/shared";
import { SessionJournal } from "./harness/session-journal.js";
import { executeLightWorkspaceRequest } from "./harness/light-executor.js";
import { RunLifecycleRegistry } from "./harness/run-lifecycle.js";
import { sha256 } from "./harness/light-identity.js";
import type { ProjectMemoryRecord } from "./harness/project-memory.js";
import type { AgentEvent } from "./types.js";

import {
  buildDevelopmentSystemPrompt,
  BlameAgentRuntime,
  backendKey,
  clineDefaultToolPolicies,
  clineErrorMetadata,
  coreBackendOptions,
  developmentUserInput,
  duplicateEventSignature,
  initializationToolPolicies,
  nextSpawnAgentActiveCount,
  newProjectGenerationToolPolicies,
  normalizeClineAgentPayload,
  retryableModelTransportFailure,
  resultFailureMessage,
  shouldDisplayClineSessionEvent,
  terminalToolEvent,
  workspaceSessionIds,
} from "./cline-runtime.js";
import { developmentSpecialistConsultEnabled } from "./specialist-agents.js";

test("exposes actionable metadata for typed Cline account errors", () => {
  assert.deepEqual(clineErrorMetadata(new ClineNotSubscribedError("cline")), {
    actionUrl: "https://app.cline.bot/dashboard/subscription?personal=true",
    code: "cline_not_subscribed",
  });
  assert.deepEqual(
    clineErrorMetadata(
      new ClineFreeModelLimitError("Free model limit reached", "cline"),
    ),
    {
      code: "cline_free_model_limit",
      resetAt: undefined,
    },
  );
});

test("uses the local backend when no workspace backend is provided", () => {
  assert.equal(backendKey(), "local");
  assert.deepEqual(coreBackendOptions(), { backendMode: "local" });
});

test("starts a Cline baseline without Blame harness tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cline-baseline-runtime-"));
  const originalFetch = globalThis.fetch;
  let capturedStart: ClineCoreStartInput | undefined;
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      capturedStart = input;
      return { result: { status: "done" }, sessionId: input.config.sessionId! };
    },
    async subscribe() {
      return () => undefined;
    },
  };
  globalThis.fetch = async () => providerCredentialResponse();
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
    developmentHarness: "cline",
  });

  try {
    await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      cwd: workspace,
      modelId: "model",
      providerId: "provider",
      summary: "Change the greeting",
      title: "Ignored benchmark label",
      workspaceRoot: workspace,
    });
    assert.equal(capturedStart?.prompt, "Change the greeting");
    assert.match(capturedStart?.config.systemPrompt ?? "", /You are Cline/u);
    assert.equal(capturedStart?.config.extraTools, undefined);
    assert.equal(capturedStart?.capabilities?.toolExecutors?.webFetch, undefined);
    assert.equal(capturedStart?.localRuntime?.hooks?.beforeModel, undefined);
    assert.deepEqual(capturedStart?.localRuntime?.configExtensions, []);
    assert.deepEqual(capturedStart?.toolPolicies, clineDefaultToolPolicies());
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("injects selected project memory into the first deferred prompt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-project-memory-"));
  const originalFetch = globalThis.fetch;
  const source = "export const carousel = true\n";
  let sentPrompt = "";
  const notices: AgentEvent[] = [];
  await writeFile(join(workspace, "carousel.ts"), source);
  const core = deferredPromptCore((prompt) => {
    sentPrompt = prompt;
  });
  globalThis.fetch = async () => providerCredentialResponse();
  const runtime = new BlameAgentRuntime(
    { emit: (event) => notices.push(event) },
    {
      createCore: async () => core as never,
      projectMemoryPersistence: {
        list: async () => [projectMemoryRecord(sha256(source))],
        save: async () => projectMemoryRecord(sha256(source)),
      },
    },
  );

  try {
    const session = await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      executionId: "memory-execution",
      modelId: "model",
      projectId: "project",
      providerId: "provider",
      summary: "Improve carousel keyboard navigation",
      title: "Carousel navigation",
      workspaceRoot: workspace,
    });
    await runtime.sessions.sendDevelopment({
      executionId: "memory-execution",
      sessionId: session.sessionId,
      storyId: "story",
      summary: "Improve carousel keyboard navigation",
      title: "Carousel navigation",
    });

    assert.match(sentPrompt, /Prior validated work/u);
    assert.match(sentPrompt, /Kept carousel state/u);
    assert.ok(notices.some(isProjectMemoryNotice));
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("deferred VM development prompts store attachments and journal remotely before reaching the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-remote-journal-"));
  const remoteRoot = join(root, "vm");
  const hostPath = join(root, "unmounted", "worktree");
  await mkdir(remoteRoot);
  await writeFile(
    join(root, "unmounted"),
    "VM path is unavailable on the host",
  );
  const originalFetch = globalThis.fetch;
  let sentPrompt = "";
  let sentFiles: string[] = [];
  const stored: Array<{ name: string; path: string }> = [];
  const context = "# Context from completed US-001\n\nLe héros validé.\n";
  const binary = Buffer.from([0, 255, 128, 10, 13, 42]);
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () =>
      deferredPromptCore((prompt, files) => {
        sentPrompt = prompt;
        sentFiles = files ?? [];
      }) as never,
    lightWorkspace: async (request) => {
      assert.equal(request.workspaceRoot, hostPath);
      assert.deepEqual(request.execution, {
        backendMode: "remote",
        workspaceMode: "local-container",
      });
      const result = await executeLightWorkspaceRequest({
        ...request,
        workspaceRoot: remoteRoot,
      });
      if (request.tool === "store_attachment") {
        assert.ok(result.status === "ok");
        stored.push({
          name: (request.input as { name: string }).name,
          path: (result.data as { path: string }).path,
        });
      }
      return result;
    },
  });
  globalThis.fetch = async () => providerCredentialResponse();
  try {
    const session = await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: hostPath,
      workspaceRoot: hostPath,
      workspaceMode: "local-container",
      backend: { mode: "remote", endpoint: "ws://runtime/hub" },
      executionId: "vm-execution",
      modelId: "model",
      providerId: "provider",
      title: "Carousel",
      summary: "Build the carousel",
      fileAttachments: [
        {
          name: "context-from-us-001.md",
          content: Buffer.from(context).toString("base64"),
          aiContextMarkdown: context,
          size: Buffer.byteLength(context),
          type: "text/markdown",
        },
      ],
    });
    assert.equal(stored.length, 1);
    assert.equal(await readFile(stored[0]!.path, "utf8"), context);
    await runtime.sessions.sendDevelopment({
      sessionId: session.sessionId,
      executionId: "vm-execution",
      title: "Carousel",
      summary: "Build the carousel",
      feedback: "Use this document too",
      feedbackFileAttachments: [
        {
          name: "../design.pdf",
          content: binary.toString("base64"),
          size: binary.length,
          type: "application/pdf",
        },
      ],
    });
    assert.match(sentPrompt, /Build the carousel/);
    assert.equal(stored.length, 2);
    assert.deepEqual(sentFiles, [stored[1]!.path]);
    assert.ok(stored.every(({ path }) =>
      path.startsWith(join(remoteRoot, ".blame", "attachments")),
    ));
    assert.deepEqual(await readFile(sentFiles[0]!), binary);
    assert.equal(
      await readFile(join(root, "unmounted"), "utf8"),
      "VM path is unavailable on the host",
    );
    const journalPath = join(
      remoteRoot,
      ".blame",
      "harness",
      "light",
      `${sha256(session.sessionId).slice(0, 24)}.jsonl`,
    );
    assert.match(await readFile(journalPath, "utf8"), /"type":"request"/);
    await (
      runtime as unknown as {
        recordSessionJournalTerminal(id: string, state: string): Promise<void>;
      }
    ).recordSessionJournalTerminal(session.sessionId, "succeeded");
    assert.match(await readFile(journalPath, "utf8"), /"type":"terminal"/);
    await assert.rejects(access(hostPath), { code: "ENOTDIR" });
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("tags session events with their execution identity", () => {
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    sessionExecutionIds: Map<string, string>;
    withExecutionId(
      sessionId: string,
      event: AgentEvent,
      executionId?: string,
    ): AgentEvent;
  };
  internals.sessionExecutionIds.set("session", "execution-current");
  const event = { payload: {}, sessionId: "session", type: "done" } as const;

  assert.equal(
    internals.withExecutionId("session", event).executionId,
    "execution-current",
  );
  assert.equal(
    internals.withExecutionId("session", event, "execution-original")
      .executionId,
    "execution-original",
  );
});

test("hides finish_task cards and projects only its native summary", () => {
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    sessionSubmittedSummaries: Map<
      string,
      {
        completion: {
          delivery: "satisfied";
          verification: "verified";
          reservations: [];
        };
        summary: string;
        verified: boolean;
      }
    >;
    withSubmittedSummary(sessionId: string, event: AgentEvent): AgentEvent;
  };
  const completion = {
    delivery: "satisfied" as const,
    verification: "verified" as const,
    reservations: [] as [],
  };
  internals.sessionSubmittedSummaries.set("session", {
    completion,
    summary: "Visible answer",
    verified: true,
  });
  assert.equal(
    terminalToolEvent({
      type: "tool",
      sessionId: "session",
      payload: { toolCall: { name: "finish_task" } },
    }),
    true,
  );
  const done = internals.withSubmittedSummary("session", {
    type: "done",
    sessionId: "session",
    payload: { text: "internal completion output" },
  });
  assert.equal((done.payload as { text: string }).text, "Visible answer");
  assert.deepEqual(
    (done.payload as { completion: unknown }).completion,
    completion,
  );
  assert.equal((done.payload as { verified: boolean }).verified, true);
});

test("publishes automatic validation as a stable run_task activity", async () => {
  const events: AgentEvent[] = [];
  const runtime = new BlameAgentRuntime({
    emit: (event) => events.push(event),
  });
  const internals = runtime as unknown as {
    publishNativeValidationActivity(
      sessionId: string,
      activity: {
        input: unknown;
        output?: unknown;
        phase: "finished" | "started";
        toolCallId: string;
      },
    ): Promise<void>;
  };
  const input = { kind: "project" as const, task: "typecheck" };
  await internals.publishNativeValidationActivity("session", {
    input,
    phase: "started",
    toolCallId: "submit:validation",
  });
  await internals.publishNativeValidationActivity("session", {
    input,
    output: { status: "ok", data: { exitCode: 0 } },
    phase: "finished",
    toolCallId: "submit:validation",
  });
  assert.deepEqual(
    events.map((event) => (event.payload as { phase: string }).phase),
    ["started", "finished"],
  );
  const finished = events[1]?.payload as Record<string, unknown>;
  assert.equal(finished.toolName, "run_task");
  assert.equal(finished.toolCallId, "submit:validation");
  assert.equal(finished.sequenceNumber, 1);
  assert.deepEqual((finished.toolCall as { input: unknown }).input, input);
});

test("prewarms and removes the reserved remote runtime session", async () => {
  const calls: string[] = [];
  const core = {
    abort: async (sessionId: string) => {
      calls.push(`abort:${sessionId}`);
    },
    delete: async (sessionId: string) => {
      calls.push(`delete:${sessionId}`);
      return true;
    },
    stop: async (sessionId: string) => {
      calls.push(`stop:${sessionId}`);
    },
    start: async (input: { config: { sessionId?: string } }) => {
      calls.push(`start:${input.config.sessionId}`);
      return { sessionId: input.config.sessionId! };
    },
  };
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
  });

  await runtime.prewarm({
    backend: {
      endpoint: "ws://127.0.0.1:25463/hub",
      mode: "remote",
    },
    cwd: "/tmp/blame-prewarm",
    workspaceRoot: "/tmp/blame-prewarm",
  });

  assert.deepEqual(calls, [
    "start:blame-runtime-prewarm",
    "stop:blame-runtime-prewarm",
    "abort:blame-runtime-prewarm",
    "delete:blame-runtime-prewarm",
  ]);
});

test("does not prewarm a local Cline backend", async () => {
  let created = false;
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => {
      created = true;
      return {} as never;
    },
  });

  await runtime.prewarm({
    backend: { mode: "local" },
    cwd: "/tmp/blame-prewarm",
    workspaceRoot: "/tmp/blame-prewarm",
  });

  assert.equal(created, false);
});

test("starts development sessions with native skills and private specialist consultation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-development-runtime-"));
  const workspaceSkillDirectory = join(
    workspace,
    ".cline",
    "skills",
    "workspace-skill",
  );
  await mkdir(workspaceSkillDirectory, { recursive: true });
  await writeFile(
    join(workspaceSkillDirectory, "SKILL.md"),
    [
      "---",
      "name: workspace-skill",
      "description: Workspace-owned regression fixture.",
      "---",
      "",
      "# Workspace skill",
    ].join("\n"),
  );
  const originalFetch = globalThis.fetch;
  let capturedStart: ClineCoreStartInput | undefined;
  let previewCall: Record<string, unknown> | undefined;
  let previewCallCount = 0;
  let previewTargetInput: Record<string, unknown> | undefined;
  let sessionSubscriber: ((event: CoreSessionEvent) => void) | undefined;
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      capturedStart = input;
      return { sessionId: input.config.sessionId! };
    },
    async subscribe(subscriber: (event: CoreSessionEvent) => void) {
      sessionSubscriber = subscriber;
      return () => undefined;
    },
  };
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          apiKey: "provider-key",
          authMethod: "api-key",
          baseUrl: null,
          id: "credential",
          label: "default",
          providerId: "provider",
        },
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
    previewDevtools: async (input) => {
      if (input.waitFor === "ready") previewTargetInput = input;
      const revisions = await currentWorkspaceRevisionState(workspace);
      return {
        application: { status: "ready" },
        available: true,
        browserUrl: "http://127.0.0.1:9222",
        loading: false,
        mcpServer: { args: [], command: "node", name: "chrome-devtools" },
        message: "The preview is ready.",
        reason: "PREVIEW_BROWSER_READY",
        readiness: {
          browser_ready: true,
          container_ready: true,
          application_ready: true,
        },
        revisions,
        status: "ready",
      };
    },
    previewDevtoolsCall: async (input) => {
      previewCallCount += 1;
      previewCall = input;
      return { content: [{ type: "text", text: "snapshot" }] };
    },
    previewDevtoolsTools: async () => [
      {
        name: "take_snapshot",
        description: "Take a snapshot",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });

  try {
    await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      modelId: "model",
      previewDevtoolsScope: "preview-scope",
      providerId: "provider",
      summary: "Improve the settings experience",
      title: "Settings polish",
      workspaceRoot: workspace,
    });

    assert.ok(capturedStart);
    assert.equal(typeof capturedStart.capabilities?.toolExecutors?.webFetch, "function");
    assert.equal(typeof capturedStart.localRuntime?.hooks?.beforeModel, "function");
    assert.equal(capturedStart.config.maxIterations, 64);
    assert.equal(capturedStart.config.enableSpawnAgent, false);
    assert.ok(capturedStart.localRuntime?.configExtensions?.includes("skills"));
    assert.ok(
      capturedStart.localRuntime?.configExtensions?.includes("plugins"),
    );
    assert.equal(capturedStart.config.pluginPaths, undefined);
    assert.equal("pluginPaths" in (capturedStart.localRuntime ?? {}), false);
    const skillService = capturedStart.localRuntime?.userInstructionService;
    assert.ok(skillService);
    const skillNames = skillService
      .listRecords("skill")
      .map((record: { item: { name: string } }) => record.item.name);
    assert.ok(skillNames.includes("impeccable"));
    assert.ok(skillNames.includes("workspace-skill"));
    assert.match(capturedStart.config.systemPrompt ?? "", /## Skill selection/);
    assert.match(capturedStart.config.systemPrompt ?? "", /Workspace-owned regression fixture/);
    assert.match(capturedStart.config.systemPrompt ?? "", /Not for backend-only/);
    const toolNames = capturedStart.config.extraTools?.map(
      (tool: { name: string }) => tool.name,
    );
    assert.ok(toolNames?.includes("consult_specialist"));
    assert.ok(toolNames?.includes("get_preview_devtools"));
    assert.ok(toolNames?.includes("preview_devtools__take_snapshot"));
    for (const name of [
      "search_code",
      "read_code",
      "edit_code",
      "run_task",
      "finish_task",
    ])
      assert.ok(toolNames?.includes(name));
    for (const name of [
      "workspace_state",
      "outline_code",
      "inspect_code",
      "recall_context",
      "edit_files",
      "mutate_dependencies",
    ])
      assert.equal(toolNames?.includes(name), false);
    assert.equal(
      capturedStart.config.extraTools?.find(
        (tool: { name: string }) => tool.name === "finish_task",
      )?.lifecycle?.completesRun,
      true,
    );
    assert.equal(
      capturedStart.config.extraTools?.filter(
        (tool: { lifecycle?: { completesRun?: boolean } }) =>
          tool.lifecycle?.completesRun,
      ).length,
      1,
    );
    assert.equal(toolNames?.includes("spawn_agent"), false);
    assert.deepEqual(capturedStart.toolPolicies?.consult_specialist, {
      autoApprove: true,
    });
    assert.deepEqual(
      capturedStart.toolPolicies?.preview_devtools__take_snapshot,
      { autoApprove: true },
    );
    assert.equal(
      capturedStart.config.extraTools?.find(
        (tool: { name: string }) => tool.name === "get_preview_devtools",
      )?.timeoutMs,
      undefined,
    );
    assert.equal(
      capturedStart.config.extraTools?.find(
        (tool: { name: string }) =>
          tool.name === "preview_devtools__take_snapshot",
      )?.timeoutMs,
      20_000,
    );
    const previewContext = { signal: new AbortController().signal } as never;
    const previewState = await capturedStart.config.extraTools
      ?.find((tool: { name: string }) => tool.name === "get_preview_devtools")
      ?.execute({ waitFor: "ready" }, previewContext);
    const previewSnapshot = await capturedStart.config.extraTools
      ?.find(
        (tool: { name: string }) =>
          tool.name === "preview_devtools__take_snapshot",
      )
      ?.execute({}, previewContext);
    assert.equal(previewTargetInput?.waitFor, "ready");
    assert.equal(previewTargetInput?.scope, "preview-scope");
    assert.equal(previewCall?.toolName, "take_snapshot");
    assert.equal(previewCall?.scope, "preview-scope");
    assert.equal(previewCallCount, 1);
    const previewStateRecord = previewState as Record<string, unknown>;
    const previewSnapshotRecord = previewSnapshot as Record<string, unknown>;
    const previewSnapshotMetadata = previewSnapshotRecord._meta as Record<
      string,
      unknown
    >;
    assert.equal(previewStateRecord.preview_ready_evidence !== undefined, true);
    assert.equal(
      previewSnapshotMetadata.previewReadyEvidence !== undefined,
      true,
    );
    const sessionId = capturedStart.config.sessionId!;
    sessionSubscriber?.(
      runtimeToolEvent(sessionId, "skills", {
        name: "workspace-skill",
      }),
    );
    sessionSubscriber?.(
      runtimeToolEvent(
        sessionId,
        "consult_specialist",
        { specialist: "reliability-reviewer" },
        { output: "Keep the Prisma move atomic." },
      ),
    );
    const journal = new SessionJournal(workspace, sessionId);
    await journal.hydrate();
    assert.deepEqual(journal.currentChanges(), []);
    assert.deepEqual(journal.currentValidations(), []);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("does not install a harness read governor around optional tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-bounded-fetch-"));
  const originalFetch = globalThis.fetch;
  let readGovernorAbsent = false;
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      readGovernorAbsent = input.config.hooks?.afterTool === undefined;
      return { result: { status: "done" }, sessionId: input.config.sessionId! };
    },
    async subscribe() {
      return () => undefined;
    },
  };
  globalThis.fetch = async () => providerCredentialResponse();
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
  });

  try {
    await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      modelId: "model",
      providerId: "provider",
      summary: "Continue after web research",
      title: "Bounded web fetch",
      workspaceRoot: workspace,
    });
    assert.equal(readGovernorAbsent, true);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("announces write auto-approval before starting the agent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-start-notice-"));
  const originalFetch = globalThis.fetch;
  const order: string[] = [];
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      order.push("start");
      return { result: { status: "done" }, sessionId: input.config.sessionId! };
    },
    async subscribe() {
      return () => undefined;
    },
  };
  globalThis.fetch = async () => providerCredentialResponse();
  const runtime = new BlameAgentRuntime(
    {
      emit: (event) => {
        const message = (event.payload as { message?: string }).message;
        if (message === "Development session write tools auto-approved.")
          order.push("notice");
      },
    },
    { createCore: async () => core as never },
  );

  try {
    await runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      cwd: workspace,
      modelId: "model",
      providerId: "provider",
      summary: "Change the greeting",
      title: "Greeting",
      workspaceRoot: workspace,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["notice", "start"]);
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("uses native Cline compaction with structural context projection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-live-compaction-"));
  const fixture = developmentCompactionFixture("true");
  try {
    await fixture.runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      maxIterations: 80,
      modelId: "claude-sonnet-4-5",
      providerId: "anthropic",
      sessionId: "native-compaction",
      summary: "Create both unfinished files and validate them later.",
      title: "Unfinished edit",
      workspaceRoot: workspace,
    });
    assert.equal(fixture.start()?.config.compaction?.enabled, true);
    assert.equal(fixture.start()?.config.compaction?.compact, undefined);
    assert.equal(fixture.start()?.config.extensions?.length, 1);
    assert.equal(
      fixture.start()?.config.extensions?.[0]?.name,
      "blame-context-projection",
    );
  } finally {
    await fixture.restore();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("disabled compaction does not install a projection extension", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-no-compaction-"));
  const fixture = developmentCompactionFixture("false");
  try {
    await fixture.runtime.sessions.startDevelopment({
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      maxIterations: 80,
      modelId: "claude-sonnet-4-5",
      providerId: "anthropic",
      summary: "Keep the complete context.",
      title: "No compaction",
      workspaceRoot: workspace,
    });
    assert.equal(fixture.start()?.config.compaction?.enabled, false);
    assert.equal(fixture.start()?.config.compaction?.compact, undefined);
    assert.equal(fixture.start()?.config.extensions, undefined);
  } finally {
    await fixture.restore();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("gives project generation direct write tools without global skills", () => {
  const policies = newProjectGenerationToolPolicies();

  for (const name of ["run_commands", "editor", "apply_patch"]) {
    assert.deepEqual(policies[name], { enabled: true, autoApprove: true });
  }
  assert.deepEqual(policies.skills, { enabled: false, autoApprove: false });
  assert.deepEqual(policies.ask_question, {
    enabled: false,
    autoApprove: false,
  });
});

test("rejects a successful project generation session that created no project", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-new-project-runtime-"));
  const fixture = newProjectGenerationFixture();

  try {
    await assert.rejects(
      fixture.runtime.newProjects.generate(
        newProjectGenerationInput(workspace),
      ),
      /completed without creating a package\.json/,
    );
    assert.deepEqual(fixture.start()?.localRuntime?.configExtensions, [
      "rules",
    ]);
    assert.equal(fixture.start()?.toolPolicies?.skills?.enabled, false);
    assert.equal(fixture.start()?.toolPolicies?.run_commands?.enabled, true);
  } finally {
    await fixture.restore();
    await rm(workspace, { force: true, recursive: true });
  }
});

function newProjectGenerationFixture() {
  const originalFetch = globalThis.fetch;
  let capturedStart: ClineCoreStartInput | undefined;
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      capturedStart = input;
      return { result: { status: "done" }, sessionId: input.config.sessionId! };
    },
    async subscribe() {
      return () => undefined;
    },
  };
  globalThis.fetch = async () => providerCredentialResponse();
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
  });
  return {
    runtime,
    start: () => capturedStart,
    async restore() {
      globalThis.fetch = originalFetch;
      await runtime.shutdown();
    },
  };
}

function providerCredentialResponse(providerId = "provider") {
  return new Response(
    JSON.stringify({
      data: {
        apiKey: "provider-key",
        authMethod: "api-key",
        baseUrl: null,
        id: "credential",
        label: "default",
        providerId,
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function deferredPromptCore(capture: (prompt: string, files?: string[]) => void) {
  return {
    async abort() {},
    async dispose() {},
    async getAccumulatedUsage() {
      return undefined;
    },
    async list() {
      return [];
    },
    async send(input: { prompt: string; userFiles?: string[] }) {
      capture(input.prompt, input.userFiles);
      return { finishReason: "completed", outputText: "Completed" };
    },
    async start(input: ClineCoreStartInput) {
      return { sessionId: input.config.sessionId! };
    },
    async stop() {},
    async subscribe() {
      return () => undefined;
    },
  };
}

for (const finishReason of ["completed", "error", "aborted"]) {
  test(`restores stopped sessions after ${finishReason} before sending comments`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "blame-session-resume-"));
    const originalFetch = globalThis.fetch;
    const starts: ClineCoreStartInput[] = [];
    const history = [
      { role: "user", content: "Keep the existing keyboard navigation" },
    ];
    const active = new Set<string>();
    const core = resumableTestCore(active, starts, history, finishReason);
    const runtime = new BlameAgentRuntime(undefined, {
      createCore: async () => core as never,
    });
    globalThis.fetch = async () => providerCredentialResponse();
    try {
      const base = {
        apiConnection: { url: "https://api.example" },
        autoSendPrompt: false,
        cwd: workspace,
        workspaceRoot: workspace,
        modelId: "model",
        providerId: "provider",
        summary: "Improve the carousel",
        title: "Carousel",
      };
      const initial = await runtime.sessions.startDevelopment({
        ...base,
        executionId: "initial",
      });
      for (const executionId of ["first-comment", "second-comment"]) {
        await runtime.sessions.sendDevelopment({
          ...base,
          sessionId: initial.sessionId,
          executionId:
            executionId === "first-comment" ? "initial" : "first-comment",
        });
        assert.equal(active.size, 0);
        const resumed = await runtime.sessions.startDevelopment({
          ...base,
          resumeSessionId: initial.sessionId,
          executionId,
        });
        assert.equal(resumed.sessionId, initial.sessionId);
        assert.deepEqual(starts.at(-1)?.initialMessages, history);
      }
      assert.equal(starts.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

function resumableTestCore(
  active: Set<string>,
  starts: ClineCoreStartInput[],
  history: unknown[],
  finishReason: string,
) {
  return {
    ...deferredPromptCore(() => undefined),
    async readLiveMessages() {
      return history;
    },
    async start(input: ClineCoreStartInput) {
      starts.push(input);
      active.add(input.config.sessionId!);
      return { sessionId: input.config.sessionId! };
    },
    async send(input: { sessionId: string }) {
      assert.ok(active.has(input.sessionId), "session not found");
      return { finishReason, outputText: "Completed" };
    },
    async stop(sessionId: string) {
      active.delete(sessionId);
    },
  };
}

test("retries session creation after a failed deferred start", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-session-start-retry-"));
  const originalFetch = globalThis.fetch;
  let starts = 0;
  const core = {
    ...deferredPromptCore(() => undefined),
    async readLiveMessages() { return []; },
    async start(input: ClineCoreStartInput) {
      if (++starts === 1) throw new Error("session.create timed out");
      return { sessionId: input.config.sessionId! };
    },
  };
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never,
  });
  globalThis.fetch = async () => providerCredentialResponse();
  try {
    const input = {
      apiConnection: { url: "https://api.example" },
      autoSendPrompt: false,
      cwd: workspace,
      workspaceRoot: workspace,
      modelId: "model",
      providerId: "provider",
      summary: "Improve the carousel",
      title: "Carousel",
      resumeSessionId: "same-conversation",
    };
    await assert.rejects(runtime.sessions.startDevelopment({ ...input, executionId: "failed" }), /timed out/u);
    const resumed = await runtime.sessions.startDevelopment({ ...input, executionId: "retry" });
    assert.equal(resumed.sessionId, input.resumeSessionId);
    assert.equal(starts, 2, "a failed start must not be reused as a live session");
  } finally {
    globalThis.fetch = originalFetch;
    await runtime.shutdown();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reuses active sessions but never restores while termination is pending", () => {
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    attachedSession(id: string): { sessionId: string } | undefined;
    runLifecycles: RunLifecycleRegistry;
    sessionContexts: Map<string, unknown>;
    unsubscribers: Map<string, () => void>;
  };
  internals.sessionContexts.set("session", {});
  internals.unsubscribers.set("session", () => undefined);
  internals.runLifecycles.begin("session", "execution");
  assert.deepEqual(internals.attachedSession("session"), {
    sessionId: "session",
  });
  internals.runLifecycles.stopping("session", "execution");
  assert.throws(() => internals.attachedSession("session"), /still stopping/u);
  internals.runLifecycles.terminationPending("session", "execution");
  assert.throws(() => internals.attachedSession("session"), /still stopping/u);
});

function projectMemoryRecord(hash: string): ProjectMemoryRecord {
  return {
    createdAt: "2026-09-03T00:00:00.000Z",
    files: [{ hash, path: "carousel.ts" }],
    fingerprint: "a".repeat(64),
    id: "memory",
    objective: "Improve carousel navigation",
    projectId: "project",
    sourceRevisionId: "revision",
    summary: "Kept carousel state in its controller.",
    symbols: ["CarouselController"],
    validationTaskId: "build",
  };
}

function isProjectMemoryNotice(event: AgentEvent) {
  return (
    event.type === "notice" &&
    (event.payload as { kind?: string }).kind === "project_memory_selected"
  );
}

function developmentCompactionFixture(enabled: "false" | "true", developmentHarness?: "blame" | "cline", providerId = "anthropic") {
  const originalFetch = globalThis.fetch;
  const originalEnabled = process.env.BLAME_AGENT_COMPACTION_ENABLED;
  let capturedStart: ClineCoreStartInput | undefined;
  const core = {
    async dispose() {},
    async list() {
      return [];
    },
    async start(input: ClineCoreStartInput) {
      capturedStart = input;
      return { sessionId: input.config.sessionId! };
    },
    async subscribe() {
      return () => undefined;
    },
  };
  process.env.BLAME_AGENT_COMPACTION_ENABLED = enabled;
  globalThis.fetch = async () => providerCredentialResponse(providerId);
  const runtime = new BlameAgentRuntime(undefined, {
    createCore: async () => core as never, developmentHarness,
  });
  return compactionFixtureResult(
    runtime,
    () => capturedStart,
    originalFetch,
    originalEnabled,
  );
}

function compactionFixtureResult(
  runtime: BlameAgentRuntime,
  start: () => ClineCoreStartInput | undefined,
  originalFetch: typeof globalThis.fetch,
  originalEnabled: string | undefined,
) {
  return {
    runtime,
    start,
    async restore() {
      globalThis.fetch = originalFetch;
      if (originalEnabled === undefined)
        delete process.env.BLAME_AGENT_COMPACTION_ENABLED;
      else process.env.BLAME_AGENT_COMPACTION_ENABLED = originalEnabled;
      await runtime.shutdown();
    },
  };
}

function newProjectGenerationInput(workspace: string) {
  return {
    apiConnection: { url: "https://api.example" },
    configuration: {
      advancedOptions: [],
      backend: "next-api",
      codeQuality: "eslint",
      database: "none",
      frontend: "next",
      orm: "none",
      packageManager: "pnpm",
      platform: "web",
      styling: "tailwind",
      uiLibrary: "none",
    },
    cwd: workspace,
    modelId: "model",
    projectName: "portfolio",
    providerId: "provider",
    sessionId: "new-project-session",
    workspaceRoot: workspace,
  };
}

test("synchronizes provider OAuth settings for initialization credentials", async () => {
  const calls: string[] = [];
  const credential = { providerId: "openai-codex" };
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    initializationCredential(input: unknown): Promise<typeof credential>;
    runtimeCredential(input: unknown): Promise<typeof credential>;
    syncClineOAuthProviderSettings(input: typeof credential): Promise<void>;
  };
  internals.runtimeCredential = async () => {
    calls.push("resolve");
    return credential;
  };
  internals.syncClineOAuthProviderSettings = async (input) => {
    assert.equal(input, credential);
    calls.push("sync");
  };

  assert.equal(await internals.initializationCredential({}), credential);
  assert.deepEqual(calls, ["resolve", "sync"]);
});

test("finds only sessions writing inside a workspace", () => {
  const workspace = join(tmpdir(), "story-42");
  const sessions = new Map([
    ["inside", join(workspace, ".blame", "logs", "cline-inside.log")],
    ["sibling", join(`${workspace}-copy`, ".blame", "logs", "cline.log")],
    ["parent", join(tmpdir(), ".blame", "logs", "cline.log")],
  ]);

  assert.deepEqual(workspaceSessionIds(sessions, workspace), ["inside"]);
});

test("drains session logs before workspace cleanup", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-worktree-cleanup-"));
  const logFile = join(workspace, ".blame", "logs", "cline-session.log");
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    abortSession(sessionId: string, humanInitiated: boolean): Promise<void>;
    sessionLogFiles: Map<string, string>;
  };
  internals.abortSession = async () => undefined;
  internals.sessionLogFiles.set("session", logFile);

  try {
    await runtime.sessions.releaseWorkspace(workspace);
    assert.match(await readFile(logFile, "utf8"), /session_unsubscribed/);
    await rm(workspace, { force: true, recursive: true });
    await runtime.sessions.unsubscribe("session");
    await assert.rejects(access(workspace));
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("does not write high-frequency streaming events to the session log", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-stream-log-"));
  const logFile = join(workspace, "cline-session.log");
  const runtime = new BlameAgentRuntime();
  const internals = runtime as unknown as {
    handleSessionEvent(sessionId: string, event: AgentEvent): Promise<void>;
    sessionLogFiles: Map<string, string>;
  };
  internals.sessionLogFiles.set("session", logFile);

  try {
    await internals.handleSessionEvent("session", {
      payload: { text: "streamed chunk" },
      sessionId: "session",
      type: "text",
    });
    await assert.rejects(access(logFile));
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("limits initialization fallback tools to project reads and search", () => {
  const policies = initializationToolPolicies();

  assert.deepEqual(policies.read_files, { enabled: true, autoApprove: true });
  assert.deepEqual(policies.search_codebase, {
    enabled: true,
    autoApprove: true,
  });
  assert.deepEqual(policies.submit_project_initialization_repair, {
    autoApprove: true,
  });
  assert.deepEqual(policies.fetch_web_content, disabledToolPolicy());
  assert.deepEqual(policies.get_preview_devtools, disabledToolPolicy());
  assert.deepEqual(policies.get_preview_container_logs, disabledToolPolicy());
  assert.deepEqual(policies.run_commands, disabledToolPolicy());
  assert.deepEqual(policies.editor, disabledToolPolicy());
  assert.deepEqual(policies.apply_patch, disabledToolPolicy());
});

test("exposes one scoped preview initialization repair action", async () => {
  let worktree = "";
  const tool = previewInitializationRepairTool(
    {
      repairPreviewInitialization: async (input) => {
        worktree = input.worktree;
        return {
          classification: "repairable_initialization",
          reason: "A database service was introduced.",
          status: "applied",
        };
      },
    },
    { worktree: "/tmp/story" },
  );

  const result = await tool?.execute({}, {} as never);

  assert.equal(worktree, "/tmp/story");
  assert.deepEqual(result, {
    classification: "repairable_initialization",
    reason: "A database service was introduced.",
    status: "applied",
  });
});

test("hides teammate agent content events", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(
      agentEvent(
        { type: "content_start", contentType: "text", text: "hidden" },
        "teammate",
      ),
    ),
    false,
  );
});

test("keeps teammate usage events", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(agentEvent({ type: "usage" }, "teammate")),
    true,
  );
});

test("hides sub-agent hook events", () => {
  assert.equal(shouldDisplayClineSessionEvent(hookEvent("child-agent")), false);
});

test("keeps lead hook events", () => {
  assert.equal(shouldDisplayClineSessionEvent(hookEvent()), true);
});

test("publishes recoverable SDK errors as notices rather than terminal failures", () => {
  const event = normalizeClineAgentPayload(
    {
      error: new Error("Provider unavailable"),
      iteration: 3,
      recoverable: true,
      type: "error",
    },
    "session",
    "raw",
  );

  assert.equal(event.type, "notice");
  assert.deepEqual(event.payload, {
    iteration: 3,
    message: "Provider unavailable",
    recoverable: true,
    raw: "raw",
  });
});

for (const type of ["error", "run-failed"]) {
  test(`keeps fatal SDK ${type} events terminal`, () => {
    const event = normalizeClineAgentPayload(
      {
        type,
        recoverable: false,
        error: new Error("Provider unavailable"),
      },
      "session",
      "raw",
    );
    assert.equal(event.type, "error");
    assert.equal(
      (event.payload as { recoverable: boolean }).recoverable,
      false,
    );
  });
}

test("records hidden completion tools with their execution identity without displaying cards", async () => {
  const { hidden, emitted, publish, runtime } = await hiddenCompletionFixture();
  for (const type of ["content_start", "content_end"])
    publish(agentEvent({ type, contentType: "tool", toolCallId: "finish-1",
      toolName: "finish_task", input: { summary: "Done" } }));
  assert.equal(hidden.length, 2);
  assert.ok(hidden.every((event) => event.executionId === "execution"));
  assert.ok(hidden.every(terminalToolEvent));
  assert.equal(emitted.filter(terminalToolEvent).length, 0);
  await runtime.shutdown();
});

async function hiddenCompletionFixture() {
  const hidden: AgentEvent[] = [];
  const emitted: AgentEvent[] = [];
  let publish: (event: CoreSessionEvent) => void = () => undefined;
  const runtime = new BlameAgentRuntime({
    emit: (event) => emitted.push(event),
    captureHiddenToolEvent: (event) => hidden.push(event),
  });
  const core = { ...deferredPromptCore(() => undefined),
    async subscribe(callback: typeof publish) { publish = callback; return () => undefined; },
  };
  const internals = runtime as unknown as TransportTestRuntime;
  await internals.subscribeCoreSession("session", core);
  internals.sessionExecutionIds.set("session", "execution");
  internals.runLifecycles.begin("session", "execution");
  return { hidden, emitted, publish, runtime };
}

test("continues delivering tools and the final response after a recoverable snapshot error", async () => {
  const emitted: AgentEvent[] = [];
  const runtime = new BlameAgentRuntime({
    emit: (event) => emitted.push(event),
  });
  let listener: (event: CoreSessionEvent) => void = () => undefined;
  let stops = 0;
  const core = {
    ...deferredPromptCore(() => undefined),
    async subscribe(callback: typeof listener) {
      listener = callback;
      return () => undefined;
    },
    async stop() {
      stops += 1;
    },
  };
  const internals = runtime as unknown as {
    subscribeCoreSession(id: string, core: unknown): Promise<void>;
    runLifecycles: RunLifecycleRegistry;
    sessionExecutionIds: Map<string, string>;
    sessionTerminalDrains: Map<string, Promise<void>>;
  };
  await internals.subscribeCoreSession("session", core);
  internals.runLifecycles.begin("session", "execution");
  internals.sessionExecutionIds.set("session", "execution");
  listener(
    agentEvent({
      type: "error",
      recoverable: true,
      error: new Error(
        "The scoped preview page is no longer available in DevTools.",
      ),
    }),
  );
  assert.equal(stops, 0);
  assert.equal(internals.runLifecycles.state("session")?.state, "running");
  listener(
    agentEvent({
      type: "content_end",
      contentType: "tool",
      toolName: "run_task",
      toolCallId: "validation",
      output: "passed",
    }),
  );
  listener(
    agentEvent({
      type: "done",
      finishReason: "completed",
      text: "Verified final response",
    }),
  );
  await internals.sessionTerminalDrains.get("session");
  assert.deepEqual(
    emitted.map((event) => event.type),
    ["notice", "tool", "done"],
  );
  assert.equal(
    (emitted.at(-1)?.payload as { text: string }).text,
    "Verified final response",
  );
  assert.equal(stops, 1);
});

test("formats failed agent results without a provider label", () => {
  const detailed = resultFailureMessage({
    finishReason: "error",
    error: new Error("Provider unavailable"),
  });
  const iterationLimit = resultFailureMessage({
    finishReason: "max_iterations",
    text: '{"status":"blocked","completionAllowed":false}',
  });
  const hyphenatedIterationLimit = resultFailureMessage({
    finishReason: "max-iterations",
  });
  const conflictingIterationLimit = resultFailureMessage({
    status: "done",
    finishReason: "max_iterations",
  });
  const generic = resultFailureMessage({ finishReason: "mistake_limit" });

  assert.equal(detailed, "Provider unavailable");
  assert.equal(
    iterationLimit,
    "Agent stopped after reaching its work-step limit before submitting a final response.",
  );
  assert.equal(
    hyphenatedIterationLimit,
    "Agent stopped after reaching its work-step limit before submitting a final response.",
  );
  assert.equal(conflictingIterationLimit, iterationLimit);
  assert.equal(
    generic,
    "Agent stopped after repeated unsuccessful actions before submitting a final response.",
  );
  assert.doesNotMatch(`${detailed} ${generic}`, /cline/i);
});

test("recognizes only retryable provider transport interruptions", () => {
  assert.equal(
    retryableModelTransportFailure(
      "Failed to process successful response: TypeError: terminated: SocketError: other side closed (UND_ERR_SOCKET)",
    ),
    true,
  );
  assert.equal(
    retryableModelTransportFailure(new Error("ECONNRESET while streaming")),
    true,
  );
  assert.equal(
    retryableModelTransportFailure(new Error("HTTP 429 rate limited")),
    false,
  );
  assert.equal(
    retryableModelTransportFailure(
      "An error occurred while processing your request. You can retry your request. Please include the request ID 4248fa32-1d4c-4645-b6ed-e6946118f013.",
    ),
    true,
  );
  assert.equal(
    retryableModelTransportFailure(new Error("HTTP 503 service unavailable")),
    true,
  );
  assert.equal(
    retryableModelTransportFailure(new Error("HTTP 401 invalid API key")),
    false,
  );
});

test("resumes a failed provider stream once from persisted state", async () => {
  const emitted: AgentEvent[] = [];
  const runtime = new BlameAgentRuntime({
    emit: (event) => emitted.push(event),
  });
  const internals = runtime as unknown as {
    runLifecycles: {
      begin(sessionId: string, executionId: string): unknown;
      state(sessionId: string): { state: string } | undefined;
    };
    sendPrompt(
      cline: unknown,
      sessionId: string,
      prompt: string,
      attachments: object,
      executionId: string,
    ): Promise<unknown>;
    sessionExecutionIds: Map<string, string>;
    sessionStartInputs: Map<string, { config: object; interactive: boolean }>;
  };
  const prompts: string[] = [];
  const core = {
    abort: async () => undefined,
    getAccumulatedUsage: async () => undefined,
    send: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      if (prompts.length === 1)
        return {
          error: {
            message:
              "Failed to process successful response: terminated (UND_ERR_SOCKET)",
          },
          finishReason: "error",
        };
      return { finishReason: "completed", outputText: "Recovered" };
    },
    stop: async () => undefined,
  };
  internals.sessionExecutionIds.set("transport-session", "execution");
  internals.sessionStartInputs.set("transport-session", {
    config: {},
    interactive: true,
  });
  internals.runLifecycles.begin("transport-session", "execution");

  await internals.sendPrompt(
    core,
    "transport-session",
    "Implement the feature",
    {},
    "execution",
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /runtime_recovery/u);
  assert.equal(
    internals.runLifecycles.state("transport-session")?.state,
    "succeeded",
  );
  assert.equal(
    emitted.some((event) => event.type === "error"),
    false,
  );
});

test("ends a noninteractive transport failure without waiting or promising a retry", async () => {
  const fixture = await transportEventFixture(false);
  try {
    fixture.publishFailure();
    await fixture.internals.sessionTerminalDrains.get("session");
    assert.equal(
      fixture.internals.runLifecycles.state("session")?.state,
      "failed",
    );
    assert.equal(fixture.prompts.length, 0);
    assert.equal(fixture.emitted.at(-1)?.type, "error");
    assert.match(
      JSON.stringify(fixture.emitted.at(-1)?.payload),
      /UND_ERR_SOCKET/u,
    );
    assert.equal(fixture.emitted.some(isTransportRecoveryNotice), false);
  } finally {
    await fixture.runtime.shutdown();
  }
});

for (const result of [undefined, { finishReason: "error" }]) {
  test(`retains the streamed transport cause when an interactive turn returns ${JSON.stringify(result)}`, async () => {
    const fixture = await transportEventFixture(true, result);
    try {
      await fixture.internals.sendPrompt(
        fixture.core,
        "session",
        "Continue",
        {},
        "execution",
      );
      assert.equal(fixture.prompts.length, 2);
      assert.match(fixture.prompts[1] ?? "", /runtime_recovery/u);
      assert.equal(
        fixture.internals.runLifecycles.state("session")?.state,
        "succeeded",
      );
      assert.equal(fixture.emitted.filter(isTransportRecoveryNotice).length, 1);
      assert.equal(fixture.noticesBeforeResolution(), 0);
    } finally {
      await fixture.runtime.shutdown();
    }
  });
}

test("ends a repeated interactive transport failure after the existing single retry", async () => {
  const fixture = await transportEventFixture(
    true,
    { finishReason: "error" },
    true,
  );
  try {
    await fixture.internals.sendPrompt(
      fixture.core,
      "session",
      "Continue",
      {},
      "execution",
    );
    assert.equal(fixture.prompts.length, 2);
    assert.equal(
      fixture.internals.runLifecycles.state("session")?.state,
      "failed",
    );
    assert.equal(
      fixture.emitted.filter((event) => event.type === "error").length,
      1,
    );
  } finally {
    await fixture.runtime.shutdown();
  }
});

test("ends a failed session start even when the SDK emitted no terminal event", async () => {
  const fixture = await transportEventFixture(false);
  try {
    await fixture.internals.completeSessionStartResult(
      fixture.core,
      {
        sessionId: "session",
        result: {
          finishReason: "error",
          error: { message: "Provider unavailable" },
        },
      },
      "execution",
    );
    assert.equal(
      fixture.internals.runLifecycles.state("session")?.state,
      "failed",
    );
    assert.equal(fixture.prompts.length, 0);
    assert.match(
      JSON.stringify(fixture.emitted.at(-1)?.payload),
      /Provider unavailable/u,
    );
  } finally {
    await fixture.runtime.shutdown();
  }
});

for (const result of [
  { finishReason: "completed", outputText: "Recovered internally" },
  { finishReason: "error", error: { message: "HTTP 401 invalid API key" } },
]) {
  test(`honors an explicit interactive result instead of replaying an earlier transport failure: ${result.finishReason}`, async () => {
    const fixture = await transportEventFixture(true, result);
    try {
      await fixture.internals.sendPrompt(
        fixture.core,
        "session",
        "Continue",
        {},
        "execution",
      );
      assert.equal(fixture.prompts.length, 1);
      assert.equal(fixture.emitted.some(isTransportRecoveryNotice), false);
      assert.equal(
        fixture.internals.runLifecycles.state("session")?.state,
        result.finishReason === "error" ? "failed" : "succeeded",
      );
    } finally {
      await fixture.runtime.shutdown();
    }
  });
}

type TransportTestRuntime = {
  completeSessionStartResult(
    core: unknown,
    session: { sessionId: string; result?: unknown },
    executionId: string,
  ): Promise<void>;
  runLifecycles: RunLifecycleRegistry;
  sendPrompt(
    core: unknown,
    sessionId: string,
    prompt: string,
    attachments: object,
    executionId: string,
  ): Promise<unknown>;
  sessionExecutionIds: Map<string, string>;
  sessionIterations: Map<string, number>;
  sessionCompletedToolIds: Map<string, Set<string>>;
  clineDefaultSessions: Set<string>;
  sessionActiveTools: Map<string, Set<string>>;
  sessionStartInputs: Map<string, { config: object; interactive: boolean }>;
  sessionTerminalDrains: Map<string, Promise<void>>;
  subscribeCoreSession(sessionId: string, core: unknown): Promise<void>;
};

test("restarts noninteractive Light transport failure with persisted effects and remaining iterations", async () => {
  const fixture = await noninteractiveRecoveryFixture();
  try {
    fixture.publishFailure();
    await fixture.internals.completeSessionStartResult(fixture.core,
      { sessionId: "session", result: { finishReason: "error" } }, "execution");
    assert.equal(fixture.starts.length, 1);
    const restart = fixture.starts[0]!;
    assert.equal(restart.interactive, false);
    assert.equal(restart.config.maxIterations, 3);
    assert.deepEqual(restart.initialMessages, fixture.messages);
    assert.deepEqual(restart.initialCompactionState, fixture.compaction);
    assert.equal(restart.userImages, undefined);
    assert.equal(restart.userFiles, undefined);
    assert.match(restart.prompt ?? "", /without repeating completed reads or mutations/u);
    assert.equal(fixture.prompts.length, 0, "A destroyed noninteractive SDK session cannot receive send");
    assert.equal(fixture.emitted.filter(isTransportRecoveryNotice).length, 1);
    assert.equal(fixture.emitted.some((event) => event.type === "error"), false);
    assert.equal(fixture.internals.runLifecycles.state("session")?.state, "succeeded");
    assert.ok(fixture.emitted.some((event) =>
      (event.payload as { iteration?: number }).iteration === 3));
  } finally { await fixture.runtime.shutdown(); }
});

for (const guard of ["exhausted", "unknown", "native", "active", "cancelled", "permanent"] as const) {
  test(`does not restart a noninteractive session when recovery is ${guard}`, async () => {
    const fixture = await noninteractiveRecoveryFixture();
    try {
      if (guard === "exhausted") fixture.internals.sessionIterations.set("session", 5);
      if (guard === "unknown") fixture.internals.sessionIterations.delete("session");
      if (guard === "native") fixture.internals.clineDefaultSessions.add("session");
      if (guard === "active") fixture.internals.sessionActiveTools.set("session", new Set(["tool"]));
      if (guard === "cancelled") fixture.internals.runLifecycles.stopping("session", "execution");
      if (guard !== "permanent") fixture.publishFailure();
      await fixture.internals.completeSessionStartResult(fixture.core,
        { sessionId: "session", result: { finishReason: "error", error: {
          message: guard === "permanent" ? "HTTP 401 invalid API key" : "UND_ERR_SOCKET" } } }, "execution");
      assert.equal(fixture.starts.length, 0);
      assert.equal(fixture.emitted.filter(isTransportRecoveryNotice).length, 0);
    } finally { await fixture.runtime.shutdown(); }
  });
}

test("cancellation while reading persisted history prevents the recovery model call", async () => {
  const fixture = await noninteractiveRecoveryFixture();
  let release: (messages: typeof fixture.messages) => void = () => undefined;
  fixture.core.readMessages = async () => new Promise((done) => { release = done; });
  try {
    fixture.publishFailure();
    const recovery = fixture.internals.completeSessionStartResult(fixture.core,
      { sessionId: "session", result: { finishReason: "error" } }, "execution");
    await new Promise((done) => setImmediate(done));
    fixture.internals.runLifecycles.stopping("session", "execution");
    release(fixture.messages);
    await recovery;
    assert.equal(fixture.starts.length, 0);
    assert.equal(fixture.emitted.filter(isTransportRecoveryNotice).length, 0);
  } finally { await fixture.runtime.shutdown(); }
});

test("a second noninteractive transport failure terminates after one restart", async () => {
  const fixture = await noninteractiveRecoveryFixture(true);
  try {
    fixture.publishFailure();
    await fixture.internals.completeSessionStartResult(fixture.core,
      { sessionId: "session", result: { finishReason: "error" } }, "execution");
    assert.equal(fixture.starts.length, 1);
    assert.equal(fixture.internals.runLifecycles.state("session")?.state, "failed");
    assert.equal(fixture.emitted.filter((event) => event.type === "error").length, 1);
  } finally { await fixture.runtime.shutdown(); }
});

test("refuses a restart if persisted history omits an observed completed tool", async () => {
  const fixture = await noninteractiveRecoveryFixture();
  try {
    fixture.internals.sessionCompletedToolIds.set("session", new Set(["unpersisted-edit"]));
    fixture.publishFailure();
    await assert.rejects(fixture.internals.completeSessionStartResult(fixture.core,
      { sessionId: "session", result: { finishReason: "error" } }, "execution"), /omits a completed tool/u);
    assert.equal(fixture.starts.length, 0);
    assert.equal(fixture.emitted.filter(isTransportRecoveryNotice).length, 0);
  } finally { await fixture.runtime.shutdown(); }
});

async function noninteractiveRecoveryFixture(repeated = false) {
  const fixture = await transportEventFixture(false);
  const starts: ClineCoreStartInput[] = [];
  const messages = [{ role: "user" as const, content: "Implement feature" },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "edit", name: "edit_code", input: {} }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "edit", content: "already applied" }] }];
  const compaction = { conversation_id: "session", source_message_count: 3 };
  const core = Object.assign(fixture.core, {
    readMessages: async () => messages,
    readSessionCompactionState: async () => compaction,
    async start(input: ClineCoreStartInput) {
      starts.push(input);
      // Emit through the same subscribed callback as a real restarted SDK.
      if (repeated) fixture.publishFailure();
      else publishDone();
      return { sessionId: "session", result: repeated ?
        { finishReason: "error", error: { message: "UND_ERR_SOCKET" } } :
        { finishReason: "completed", outputText: "Recovered" } };
    },
  });
  let publishDone: () => void = () => undefined;
  await fixture.internals.subscribeCoreSession("session", {
    ...core, async subscribe(listener: (event: CoreSessionEvent) => void) {
      publishDone = () => {
        listener(agentEvent({ type: "iteration_start", iteration: 1 }));
        listener(agentEvent({ type: "done", reason: "completed", text: "Recovered" }));
      };
      // Keep the original fixture's failure publisher connected too.
      await core.subscribe(listener);
      return () => undefined;
    },
  });
  fixture.internals.sessionExecutionIds.set("session", "execution");
  fixture.internals.runLifecycles.begin("session", "execution");
  fixture.internals.sessionIterations.set("session", 2);
  fixture.internals.sessionCompletedToolIds.set("session", new Set(["edit"]));
  fixture.internals.sessionStartInputs.set("session", { interactive: false, config: {
    maxIterations: 5, extraTools: [{ name: "finish_task" }] } });
  return { ...fixture, core, starts, messages, compaction };
}

type TransportTestState = {
  earlyNotices: number;
  emitted: AgentEvent[];
  listener(event: CoreSessionEvent): void;
  prompts: string[];
};

async function transportEventFixture(
  interactive: boolean,
  result?: unknown,
  repeated = false,
) {
  const state: TransportTestState = {
    earlyNotices: 0,
    emitted: [],
    listener: () => undefined,
    prompts: [],
  };
  const core = transportTestCore(state, result, repeated);
  const runtime = new BlameAgentRuntime(
    { emit: (event) => state.emitted.push(event) },
    { createCore: async () => core as never },
  );
  const internals = runtime as unknown as TransportTestRuntime;
  await internals.subscribeCoreSession("session", core);
  internals.sessionExecutionIds.set("session", "execution");
  internals.sessionStartInputs.set("session", { config: {}, interactive });
  internals.runLifecycles.begin("session", "execution");
  return {
    core,
    emitted: state.emitted,
    internals,
    prompts: state.prompts,
    publishFailure: () => publishTransportFailure(state),
    runtime,
    noticesBeforeResolution: () => state.earlyNotices,
  };
}

function transportTestCore(
  state: TransportTestState,
  result: unknown,
  repeated: boolean,
) {
  return {
    ...deferredPromptCore(() => undefined),
    async subscribe(listener: TransportTestState["listener"]) {
      state.listener = listener;
      return () => undefined;
    },
    async send({ prompt }: { prompt: string }) {
      state.prompts.push(prompt);
      if (state.prompts.length > 1 && !repeated)
        return { finishReason: "completed", outputText: "Recovered" };
      publishTransportFailure(state);
      state.earlyNotices = state.emitted.filter(
        isTransportRecoveryNotice,
      ).length;
      return result;
    },
  };
}

function publishTransportFailure(state: TransportTestState) {
  state.listener(
    agentEvent({
      type: "error",
      message: "Provider stream closed (UND_ERR_SOCKET)",
    }),
  );
}

function isTransportRecoveryNotice(event: AgentEvent) {
  return (
    event.type === "notice" && /resuming/u.test(JSON.stringify(event.payload))
  );
}

test("never projects an internal payload as the final assistant response", () => {
  const internalPayload = JSON.stringify({
    status: "blocked",
    completionAllowed: false,
    reason: "NO_POST_EDIT_VALIDATION",
  });
  const event = normalizeClineAgentPayload(
    {
      type: "done",
      reason: "max_iterations",
      text: internalPayload,
      iteration: 80,
    },
    "session",
    internalPayload,
  );

  assert.equal(event.type, "error");
  assert.equal(
    (event.payload as { message?: string }).message,
    "Agent stopped after reaching its work-step limit before submitting a final response.",
  );
  assert.doesNotMatch(JSON.stringify(event.payload), /completionAllowed/iu);
  assert.doesNotMatch(JSON.stringify(event.payload), /Work completed/iu);
});

test("keeps unknown tool payloads out of assistant text events", () => {
  const event = normalizeClineAgentPayload(
    {
      type: "tool-result",
      toolCallId: "internal-tool",
      content: '{"status":"blocked"}',
    },
    "session",
    "raw",
  );

  assert.equal(event.type, "raw");
});

test("hides untagged sub-agent text while spawn agent is active", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(
      agentEvent({
        type: "content_start",
        contentType: "text",
        text: "hidden",
      }),
      true,
    ),
    false,
  );
});

test("hides untagged sub-agent tools while spawn agent is active", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(
      agentEvent({
        type: "content_start",
        contentType: "tool",
        toolName: "read_files",
      }),
      true,
    ),
    false,
  );
});

test("keeps spawn agent tool events while spawn agent is active", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(
      agentEvent({
        type: "content_end",
        contentType: "tool",
        toolName: "spawn_agent",
      }),
      true,
    ),
    true,
  );
});

test("keeps usage events while spawn agent is active", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(agentEvent({ type: "usage" }), true),
    true,
  );
});

test("keeps spawn agent hook result while spawn agent is active", () => {
  assert.equal(
    shouldDisplayClineSessionEvent(
      hookEvent(undefined, "spawn_agent", "tool_result"),
      true,
    ),
    true,
  );
});

test("tracks multiple parallel spawn agents", () => {
  let activeCount = 0;
  activeCount = nextSpawnAgentActiveCount(activeCount, "started");
  activeCount = nextSpawnAgentActiveCount(activeCount, "started");
  activeCount = nextSpawnAgentActiveCount(activeCount, "started");
  activeCount = nextSpawnAgentActiveCount(activeCount, "finished");
  assert.equal(activeCount, 2);
});

test("does not deduplicate spawn agent tools by tool name", () => {
  assert.equal(duplicateEventSignature(toolEvent("spawn_agent")), undefined);
});

test("keeps duplicate signatures for regular tools", () => {
  assert.equal(
    duplicateEventSignature(toolEvent("read_files")),
    "session:call-read_files:started:0",
  );
});

test("tool lifecycle identity separates parallel tools and every phase", () => {
  const first = toolEvent("read_files", "call-a", "started", 0);
  const second = toolEvent("read_files", "call-b", "started", 0);
  const progress = toolEvent("read_files", "call-a", "progress", 1);
  const finished = toolEvent("read_files", "call-a", "finished", 2);
  assert.notEqual(
    duplicateEventSignature(first),
    duplicateEventSignature(second),
  );
  assert.notEqual(
    duplicateEventSignature(first),
    duplicateEventSignature(progress),
  );
  assert.notEqual(
    duplicateEventSignature(progress),
    duplicateEventSignature(finished),
  );
});

test("cancelled tools and reconnect replays retain stable identities", () => {
  const cancelled = toolEvent("run_task", "manual-stop", "cancelled", 3);
  const replay = toolEvent("run_task", "manual-stop", "cancelled", 3);
  assert.equal(
    duplicateEventSignature(cancelled),
    duplicateEventSignature(replay),
  );
  assert.match(duplicateEventSignature(cancelled) ?? "", /cancelled:3$/u);
});

test("normalizes tool lifecycle metadata without delaying fast tools", () => {
  const runtime = new BlameAgentRuntime();
  const lifecycle = (
    runtime as unknown as {
      withToolLifecycle(sessionId: string, event: AgentEvent): AgentEvent;
    }
  ).withToolLifecycle.bind(runtime);
  const started = lifecycle(
    "session",
    toolEvent("read_files", "fast", "started", 0),
  );
  const finished = lifecycle(
    "session",
    toolEvent("read_files", "fast", "finished", 1),
  );
  assert.equal((started.payload as { phase: string }).phase, "started");
  assert.equal((finished.payload as { phase: string }).phase, "finished");
  assert.equal(
    (finished.payload as { sequenceNumber: number }).sequenceNumber,
    1,
  );
  assert.equal(
    typeof (finished.payload as { timestamp: string }).timestamp,
    "string",
  );
});

test("keeps development feedback attachments out of the prompt", async () => {
  const attachmentDirectory = await mkdtemp(join(tmpdir(), "blame-test-"));
  try {
    const input = await developmentUserInput(
      {
        feedback: "Use these files",
        feedbackFileAttachments: [
          fileAttachment("screenshot.png", "image/png"),
          fileAttachment("notes.txt", "text/plain"),
        ],
        feedbackOnly: true,
        summary: "Summary",
        title: "Title",
      },
      attachmentDirectory,
    );

    assert.equal(input.userImages.length, 1);
    assert.equal(input.userFiles.length, 1);
    assert.match(input.userImages[0] ?? "", /^data:image\/png;base64,/);
    assert.equal(input.userFiles[0]?.startsWith(attachmentDirectory), true);
    assert.doesNotMatch(input.prompt, /data:image\/png;base64,/);
    assert.doesNotMatch(input.prompt, /aGVsbG8=/);
    assert.equal(input.prompt.includes(attachmentDirectory), false);
    assert.match(input.prompt, /Images attached for model vision: 1/);
    assert.match(input.prompt, /Files attached for Cline context: 1/);
  } finally {
    await rm(attachmentDirectory, { force: true, recursive: true });
  }
});

test("uses local attachment content without downloading its stored copy", async () => {
  const attachmentDirectory = await mkdtemp(join(tmpdir(), "blame-test-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Stored attachment should not be downloaded");
  };

  try {
    const input = await developmentUserInput(
      {
        fileAttachments: [
          {
            ...fileAttachment("screenshot.png", "image/png"),
            downloadUrl: "https://storage.example/screenshot",
          },
        ],
        summary: "Summary",
        title: "Title",
      },
      attachmentDirectory,
    );

    assert.deepEqual(input.userImages, ["data:image/png;base64,aGVsbG8="]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(attachmentDirectory, { force: true, recursive: true });
  }
});

test("renews an expired attachment download URL", async () => {
  const attachmentDirectory = await mkdtemp(join(tmpdir(), "blame-test-"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ authorization?: string; url: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      authorization:
        new Headers(init?.headers).get("authorization") ?? undefined,
      url,
    });
    if (url === "https://storage.example/expired") {
      return new Response(null, { status: 403 });
    }
    if (url.endsWith("/attachments/attachment-id")) {
      return Response.json({
        downloadUrl: "https://storage.example/current",
      });
    }
    return new Response("hello");
  };

  try {
    const input = await developmentUserInput(
      {
        apiConnection: { token: "token", url: "https://api.example/api/v1" },
        feedbackFileAttachments: [
          {
            downloadUrl: "https://storage.example/expired",
            id: "attachment-id",
            name: "notes.txt",
            size: 5,
            type: "text/plain",
          },
        ],
        feedbackOnly: true,
        summary: "Summary",
        title: "Title",
      },
      attachmentDirectory,
    );

    assert.equal(await readFile(input.userFiles[0]!, "utf8"), "hello");
    assert.equal(requests[1]?.authorization, "Bearer token");
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "https://storage.example/expired",
        "https://api.example/api/v1/attachments/attachment-id",
        "https://storage.example/current",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(attachmentDirectory, { force: true, recursive: true });
  }
});

test("renders the compact native Cline development prompt", async () => {
  const prompt = await buildDevelopmentSystemPrompt({
    apiConnection: { token: "token", url: "https://example.com" },
    codePractices: [
      { enabled: true, practice: "coding_style" },
      { enabled: false, practice: "layered_architecture" },
      { enabled: true, practice: "unit_tests" },
    ],
    cwd: process.cwd(),
    modelId: "model",
    providerId: "provider",
    summary: "Summary",
    title: "Title",
    workspaceRoot: process.cwd(),
  });

  assert.match(prompt, /^# Blame Development Agent/);
  assert.match(prompt, /<runtime_context>/);
  assert.match(prompt, /<workspace_metadata>/);
  assert.match(prompt, /briefing as evidence already gathered/);
  assert.match(
    prompt,
    /Prefer symbol operations when they reduce ambiguity or text/,
  );
  assert.match(
    prompt,
    /`run_task` for inspection, validation, generation/,
  );
  assert.match(prompt, /call `finish_task`/);
  assert.doesNotMatch(prompt, /complete_turn/);
  assert.doesNotMatch(prompt, /continuity_update|change_receipt_refs/);
  assert.doesNotMatch(
    prompt,
    /workspace_state|source_revision|execution[_ ]epoch/iu,
  );
  assert.doesNotMatch(prompt, /submit_and_exit/);
  assert.doesNotMatch(prompt, /## Blame Specialist Consultations/);
  assert.doesNotMatch(prompt, /consult_specialist/);
  assert.doesNotMatch(prompt, /get_preview_devtools/);
  assert.doesNotMatch(prompt, /<system_prompt/);
  assert.doesNotMatch(prompt, /## Specialist knowledge/);
  assert.doesNotMatch(prompt, /Jobs To Be Done/);
  assert.doesNotMatch(prompt, /Gestalt grouping/);
  assert.ok(prompt.length < 15_000);
  assert.match(prompt, /## Coding Style: Standard Industrial Professional/);
  assert.match(prompt, /## Architecture: Match Codebase/);
  assert.match(prompt, /## Unit Tests: Professional TDD/);
  assert.match(
    prompt,
    new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(prompt, /You are Cline/);
  assert.doesNotMatch(prompt, /CLINE_RULES|CLINE_METADATA/);
});

test("enables specialists for interactive or explicit one-shot requests", () => {
  const base = { summary: "Update the API", title: "API change" };
  assert.equal(developmentSpecialistConsultEnabled(base), false);
  assert.equal(
    developmentSpecialistConsultEnabled({
      ...base,
      summary: "Ask a risk specialist to review the migration",
    }),
    true,
  );
  assert.equal(
    developmentSpecialistConsultEnabled({ ...base, autoSendPrompt: false }),
    true,
  );
  assert.equal(
    developmentSpecialistConsultEnabled({
      ...base,
      autoSendPrompt: false,
      enableSpecialistConsult: false,
    }),
    false,
  );
});

test("includes optional guidance only for interactive scoped sessions", async () => {
  const prompt = await buildDevelopmentSystemPrompt({
    apiConnection: { token: "token", url: "https://example.com" },
    autoSendPrompt: false,
    cwd: process.cwd(),
    modelId: "model",
    previewDevtoolsScope: "preview-scope",
    providerId: "provider",
    summary: "Improve the settings experience",
    title: "Settings polish",
    workspaceRoot: process.cwd(),
  });
  assert.match(prompt, /## Blame Specialist Consultations/);
  assert.match(prompt, /consult_specialist/);
  assert.match(prompt, /get_preview_devtools/);
  assert.match(prompt, /managed by Blame/);
});

test("an absent test preference leaves validation choices to the agent", async () => {
  for (const codePractices of [undefined, [], [{ practice: "coding_style" as const, enabled: true }]]) {
    const prompt = await buildDevelopmentSystemPrompt({
      apiConnection: { token: "token", url: "https://example.com" },
      codePractices,
      cwd: process.cwd(), modelId: "model", providerId: "provider",
      summary: "Implement the request", title: "Change", workspaceRoot: process.cwd(),
    });
    assert.doesNotMatch(prompt, /Unit Tests: Disabled|do not add tests|Professional TDD/);
    assert.match(prompt, /choose additional tests when the change needs them/);
  }
});

test("keeps explicit development practices concise and actionable", async () => {
  const prompt = await buildDevelopmentSystemPrompt({
    apiConnection: { token: "token", url: "https://example.com" },
    codePractices: [
      { enabled: true, practice: "coding_style" },
      { enabled: false, practice: "layered_architecture" },
      { enabled: false, practice: "unit_tests" },
    ],
    cwd: process.cwd(),
    modelId: "model",
    providerId: "provider",
    summary: "Summary",
    title: "Title",
    workspaceRoot: process.cwd(),
  });

  assert.ok(Buffer.byteLength(prompt) < 6_500);
  assert.match(prompt, /Use precise names, focused functions/);
  assert.match(prompt, /Preserve the existing architecture/);
  assert.match(prompt, /Unless the user explicitly asks for tests/);
  assert.match(prompt, /Keep structural changes scoped/);
  assert.match(prompt, /Never silently mask errors/);
});

function agentEvent(
  event: Record<string, unknown>,
  teamRole?: "lead" | "teammate",
): CoreSessionEvent {
  return {
    payload: {
      event,
      sessionId: "session",
      ...(teamRole ? { teamRole } : {}),
    },
    type: "agent_event",
  } as CoreSessionEvent;
}

function runtimeToolEvent(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  output?: unknown,
): CoreSessionEvent {
  return {
    payload: {
      event: {
        toolCall: { id: `call-${toolName}`, input, name: toolName },
        ...(output === undefined ? {} : { output }),
        type: "tool-finished",
      },
      sessionId,
    },
    type: "agent_event",
  } as CoreSessionEvent;
}

function hookEvent(
  parentAgentId?: string,
  toolName = "read_files",
  hookEventName = "tool_call",
): CoreSessionEvent {
  return {
    payload: {
      hookEventName,
      parentAgentId,
      sessionId: "session",
      toolName,
    },
    type: "hook",
  } as CoreSessionEvent;
}

function toolEvent(
  toolName: string,
  toolCallId = `call-${toolName}`,
  phase = "started",
  sequenceNumber = 0,
): AgentEvent {
  return {
    payload: {
      phase,
      sequenceNumber,
      toolCall: { id: toolCallId, name: toolName },
      toolCallId,
      toolName,
    },
    sessionId: "session",
    type: "tool",
  };
}

function disabledToolPolicy() {
  return { enabled: false, autoApprove: false };
}

function fileAttachment(name: string, type: string) {
  return {
    content: Buffer.from("hello").toString("base64"),
    name,
    size: 5,
    type,
  };
}

test("development instructions describe only caller-declared isolation", async () => {
  const input = { apiConnection: { token: "token", url: "https://example.test" },
    cwd: process.cwd(), workspaceRoot: process.cwd(), modelId: "model", providerId: "provider",
    title: "Environment", summary: "Configure a service" };
  const host = await buildDevelopmentSystemPrompt(input);
  const isolated = await buildDevelopmentSystemPrompt({ ...input, isolatedEnvironment: true });
  assert.match(host, /current process permissions/);
  assert.doesNotMatch(host, /inside an isolated task environment/);
  assert.match(isolated, /inside an isolated task environment/);
  assert.doesNotMatch(isolated, /get_preview_devtools/);
});

for (const harness of ["blame", "cline"] as const) {
  test(`${harness} receives only its configured image compaction behavior`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "image-compaction-runtime-"));
    const fixture = developmentCompactionFixture("true", harness, "openai-native");
    try {
      await fixture.runtime.sessions.startDevelopment({
        apiConnection: { url: "https://api.example" }, autoSendPrompt: false, cwd: workspace,
        modelId: "gpt-5.6-luna", providerId: "openai-native", summary: "Inspect an image.",
        title: "Image input", workspaceRoot: workspace,
      });
      assert.equal(fixture.start()?.config.compaction?.imageTokenLimit, harness === "blame" ? 36_000 : undefined);
    } finally {
      await fixture.restore();
      await rm(workspace, { force: true, recursive: true });
    }
  });
}

for (const failed of [false, true]) {
  test(`native completion consumes the same check state without another model request (${failed ? "failed" : "unknown"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "blame-native-finish-"));
    const emitted: AgentEvent[] = [];
    const runtime = new BlameAgentRuntime({ emit: (event) => emitted.push(event) });
    try {
      const { LightFinishService } = await import("./harness/light-finish-service.js");
      const journal = new SessionJournal(root, "native-test");
      const { WorkspaceFiles } = await import("./harness/workspace-files.js");
      const snapshot = await new WorkspaceFiles(root).snapshot();
      await journal.recordValidation({ command: "node --test", paths: [], taskKind: "test",
        sourceRevisionId: snapshot.revision.source_revision_id, status: failed ? "failed" : "unknown",
        ...(failed ? { category: "code" as const } : {}) });
      const internals = runtime as unknown as {
        runLifecycles: RunLifecycleRegistry;
        sessionNativeFinish: Map<string, (summary: string) => Promise<unknown>>;
        sessionSubmittedSummaries: Map<string, unknown>;
        finalizeSessionTermination(input: unknown): Promise<void>;
      };
      const finish = new LightFinishService({ workspaceRoot: root, conversationId: "native-test",
        onComplete: (notification) => { internals.sessionSubmittedSummaries.set("native-test", notification); } });
      internals.sessionNativeFinish.set("native-test", (summary) => finish.finish(summary, {} as never));
      internals.runLifecycles.begin("native-test", "execution");
      await internals.finalizeSessionTermination({ sessionId: "native-test", executionId: "execution",
        terminalState: "succeeded", display: true, cline: { getAccumulatedUsage: async () => undefined },
        event: { type: "done", sessionId: "native-test", payload: { text: "Done" } } });
      assert.equal(internals.runLifecycles.state("native-test")?.state, failed ? "failed" : "succeeded");
      const terminal = emitted.filter((event) => event.type === "done" || event.type === "error");
      assert.equal(terminal.length, 1);
      if (!failed) assert.equal((terminal[0]!.payload as { verified: boolean }).verified, false);
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}

test("gives the model a reason for every refused tool call", async () => {
  const approvals: { id: string }[] = [];
  const runtime = new BlameAgentRuntime({
    emit: (event) => {
      if (event.type === "approval") approvals.push(event.payload as { id: string });
    },
  });
  type Approval = { approved: boolean; reason?: string };
  const internals = runtime as unknown as {
    requestApproval(request: unknown): Promise<Approval> | Approval;
    resolveApproval(input: { requestId: string; decision: string }): boolean;
    resolvePendingApprovals(): void;
  };
  const request = (input: unknown, toolName = "edit_code") =>
    internals.requestApproval({ input, toolName });

  assert.deepEqual(await request({ command: "sudo reboot" }, "run_commands"), {
    approved: false,
    reason: "Command blocked by security policy",
  });

  const denied = request({ path: "a.ts" });
  internals.resolveApproval({ requestId: approvals[0]!.id, decision: "deny" });
  assert.deepEqual(await denied, { approved: false, reason: USER_REJECTED_TOOL_REASON });

  const approved = request({ path: "a.ts" });
  internals.resolveApproval({ requestId: approvals[1]!.id, decision: "approve" });
  assert.deepEqual(await approved, { approved: true });

  const stopped = request({ path: "a.ts" });
  internals.resolvePendingApprovals();
  const result = await stopped;
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /session stopped before the user answered/);
});

test("keeps a still-valid OAuth token when a forced refresh fails", async () => {
  const runtime = new BlameAgentRuntime();
  const credential = (expires: number) => ({
    authMethod: "oauth",
    providerId: "openai-codex",
    oauthCredentials: { access: "access", refresh: "refresh", expires },
  });
  const internals = runtime as unknown as {
    oauthProvider(providerId: string): Promise<unknown>;
    refreshOAuthCredential(
      connection: unknown,
      input: ReturnType<typeof credential>,
      options: { force: boolean },
    ): Promise<unknown>;
  };
  internals.oauthProvider = async () => ({
    refreshToken: async () => {
      throw new Error("refresh endpoint unavailable");
    },
  });

  const valid = credential(Date.now() + 3_600_000);
  assert.equal(await internals.refreshOAuthCredential({}, valid, { force: true }), valid);
  await assert.rejects(
    internals.refreshOAuthCredential({}, credential(Date.now() - 1), { force: true }),
    /refresh endpoint unavailable/,
  );
});
