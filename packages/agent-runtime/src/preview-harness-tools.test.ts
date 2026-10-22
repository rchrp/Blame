import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentWorkspaceRevisionState } from "./harness/workspace-revisions.js";
import {
  previewDevtoolsMcpTools,
  type PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";
import { previewDevtoolsToolTimeoutMs } from "./preview-devtools-policy.js";

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
      { scope: "preview", worktree: workspace },
      { log() {} },
    );
    const result = (await tools[0].execute({}, {
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>;
    assert.equal(calls, 1);
    assert.equal(result.isError, false);
    assert.equal(result.outcome, "unavailable");
    assert.equal(result.retryable, false);
    assert.match(
      JSON.stringify(result.content),
      new RegExp(diagnostic.replaceAll(".", "\\.")),
    );
  });
}

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
  assert.equal(timeouts.preview_devtools__click, 20_000);
  assert.equal(timeouts.preview_devtools__lighthouse_audit, 125_000);
  for (const name of ["click", "lighthouse_audit"])
    assert.ok(
      timeouts[`preview_devtools__${name}`]! >
        previewDevtoolsToolTimeoutMs(name),
    );
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
