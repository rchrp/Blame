import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentWorkspaceRevisionState } from "./harness/workspace-revisions.js";
import {
  previewDevtoolsMcpTools,
  projectAppTool,
  type PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";
import { runtimeTools } from "./cline-runtime-tools.js";
import {
  previewDevtoolsMaxTimeoutMs,
  previewDevtoolsToolTimeoutMs,
} from "./preview-devtools-policy.js";

const unavailableErrors = [
  "ECONNRESET",
  "Request timed out",
  "Transport closed",
  "Target closed",
  "The scoped preview page is no longer available in DevTools.",
];

for (const diagnostic of unavailableErrors) {
  test(`reports ${diagnostic} without replaying an interaction or failing the run`, async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), "blame-preview-failure-"));
    context.after(() => rm(workspace, { recursive: true, force: true }));
    let calls = 0;
    const tools = await previewDevtoolsMcpTools(
      await readyPreviewOptions(workspace, () => {
        calls += 1;
        throw new Error(diagnostic);
      }),
      { scope: `preview ${diagnostic}`, worktree: workspace },
      { log() {} },
    );
    const execute = async () =>
      (await tools[0].execute({}, {
        sessionId: `session ${diagnostic}`,
        signal: new AbortController().signal,
      } as never)) as Record<string, unknown>;
    // The desktop resets the connection, so one retry is suggested...
    const first = await execute();
    assert.equal(calls, 1);
    assert.equal(first.isError, false);
    assert.equal(first.outcome, "unavailable");
    assert.equal(first.retryable, true);
    assert.match(String(first.recommendation), /Retry this call once/u);
    assert.match(
      JSON.stringify(first.content),
      new RegExp(diagnostic.replaceAll(".", "\\.")),
    );
    // ...but not a second time in a row.
    const second = await execute();
    assert.equal(calls, 2);
    assert.equal(second.retryable, false);
    assert.match(String(second.recommendation), /local validation/u);
  });
}

test("a successful call clears the transient failure count", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-failure-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  let calls = 0;
  const options = await readyPreviewOptions(workspace, () => {
    throw new Error("unused");
  });
  options.previewDevtoolsCall = () => {
    calls += 1;
    if (calls === 2) return { content: [{ type: "text", text: "ok" }] };
    throw new Error("Preview DevTools click did not finish within 20 s.");
  };
  const tools = await previewDevtoolsMcpTools(
    options,
    { scope: "preview-reset", worktree: workspace },
    { log() {} },
  );
  const execute = async () =>
    (await tools[0].execute({}, {
      sessionId: "session-reset",
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;
  assert.equal((await execute()).retryable, true);
  await execute();
  assert.equal((await execute()).retryable, true);
});

test("unexpected preview implementation errors remain errors", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-failure-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const tools = await previewDevtoolsMcpTools(
    await readyPreviewOptions(workspace, () => {
      throw new Error("Invalid implementation state");
    }),
    { scope: "preview", worktree: workspace },
    { log() {} },
  );
  await assert.rejects(
    tools[0].execute({}, { signal: new AbortController().signal } as never),
    /Invalid implementation state/,
  );
});

test("each browser tool waits longer than the desktop service does", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-timeouts-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const listed: unknown[] = [];
  const options = await readyPreviewOptions(workspace, () => {
    throw new Error("not called");
  });
  options.previewDevtoolsTools = (input) => {
    listed.push(input);
    return ["click", "lighthouse_audit"].map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    }));
  };
  const tools = await previewDevtoolsMcpTools(
    options,
    { projectId: "project-1", scope: "preview", worktree: workspace },
    { log() {} },
  );
  const timeouts = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.timeoutMs]),
  );
  // The service may stretch a call up to its ceiling (slow emulation, a
  // long wait asked by the agent); the agent always waits past it.
  for (const name of ["click", "lighthouse_audit"]) {
    assert.ok(
      timeouts[`preview_devtools__${name}`]! > previewDevtoolsMaxTimeoutMs,
    );
    assert.ok(
      timeouts[`preview_devtools__${name}`]! >
        previewDevtoolsToolTimeoutMs(name, {
          arguments: { timeout: 10_000_000 },
          slowdown: { cpuThrottlingRate: 20, networkConditions: "Slow 3G" },
        }),
    );
  }
  // The project decides whether advanced tools are listed.
  assert.equal((listed[0] as { projectId?: string }).projectId, "project-1");
});

async function readyPreviewOptions(
  worktree: string,
  call: () => never,
): Promise<PreviewToolRuntimeOptions> {
  const revisions = await currentWorkspaceRevisionState(worktree);
  return {
    previewDevtools: () => ({
      available: true,
      loading: false,
      message: "Ready",
      reason: "PREVIEW_BROWSER_READY",
      readiness: {
        browser_ready: true,
        container_ready: true,
        application_ready: true,
      },
      revisions,
      status: "ready",
    }),
    previewDevtoolsCall: call,
    previewDevtoolsTools: () => [
      { name: "click", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

test("a story in the project folder checks and starts the project's app through Blame", async () => {
  const calls: unknown[] = [];
  const options: PreviewToolRuntimeOptions = {
    projectApp: (input) => {
      calls.push({ action: input.action, worktree: input.worktree });
      return { status: "starting" };
    },
  };
  const direct = {
    scope: "runner:/p:web",
    workspaceMode: "direct" as const,
    worktree: "/p",
  };
  assert.equal(
    projectAppTool(options, { ...direct, workspaceMode: "local-container" }),
    undefined,
  );
  assert.equal(projectAppTool({}, direct), undefined);
  const tool = projectAppTool(options, direct);
  assert.equal(tool?.name, "project_app");
  await tool!.execute({ action: "start" }, {} as never);
  await tool!.execute({}, {} as never);
  assert.deepEqual(calls, [
    { action: "start", worktree: "/p" },
    { action: "status", worktree: "/p" },
  ]);
});

test("a direct story gets the project app tool, not the managed container's", () => {
  const options = {
    previewContainerLogs: () => ({}),
    previewDevtools: () => undefined,
    projectApp: () => ({}),
    repairPreviewInitialization: () => ({
      classification: "",
      reason: "",
      status: "unavailable" as const,
    }),
  };
  const names = (workspaceMode: "direct" | "local-container") =>
    (
      runtimeTools(options, "/p", {
        scope: "s",
        workspaceMode,
        worktree: "/p",
      }) ?? []
    ).map((tool) => tool.name);
  const direct = names("direct");
  assert.ok(direct.includes("project_app"));
  assert.ok(direct.includes("get_preview_devtools"));
  assert.ok(!direct.includes("repair_preview_initialization"));
  assert.ok(!direct.includes("get_preview_container_logs"));
  const isolated = names("local-container");
  assert.ok(!isolated.includes("project_app"));
  assert.ok(isolated.includes("repair_preview_initialization"));
});
