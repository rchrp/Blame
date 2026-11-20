import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentWorkspaceRevisionState } from "../../harness/workspace-revisions.js";
import {
  previewDevtoolsMaxTimeoutMs,
  previewDevtoolsToolTimeoutMs,
} from "../../preview-devtools-policy.js";
import type { ClientTool } from "../tool.js";
import {
  boundedSurfaceArguments,
  previewClientTools,
  previewContainerLogsTool,
  previewDevtoolsMcpTools,
  previewDevtoolsTool,
  previewEnvironmentTool,
  previewInitializationRepairTool,
  projectAppTool,
  type PreviewToolServices,
} from "./preview.js";
import type {
  PreviewEnvironmentToolInput,
  PreviewRuntimeContext,
} from "./preview-types.js";
import { callThroughToolSet, toolContext } from "./testing.js";

/** What the model reads of a call that answers JSON. */
async function json(
  tool: ClientTool<never>,
  input: Record<string, unknown> = {},
  session = "session-1",
) {
  const output = await tool.run(input as never, toolContext({ session }));
  return (output as { json: Record<string, unknown> }).json;
}

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
    );
    const execute = () => json(tools[0]!, {}, `session ${diagnostic}`);
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
  options.previewDevtoolsCall = async () => {
    calls += 1;
    if (calls === 2) return { content: [{ type: "text", text: "ok" }] };
    throw new Error("Preview DevTools click did not finish within 20 s.");
  };
  const tools = await previewDevtoolsMcpTools(options, {
    scope: "preview-reset",
    worktree: workspace,
  });
  const execute = () => json(tools[0]!, {}, "session-reset");
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
  );
  await assert.rejects(
    async () => tools[0]!.run({} as never, toolContext()),
    /Invalid implementation state/,
  );
});

test("each browser tool waits longer than the desktop service does", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-timeouts-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const options = await readyPreviewOptions(workspace, () => {
    throw new Error("not called");
  });
  options.previewDevtoolsTools = async () => {
    return ["click", "wait_for"].map((name) => ({
      name,
      inputSchema: { type: "object", properties: {} },
    }));
  };
  const tools = await previewDevtoolsMcpTools(options, {
    projectId: "project-1",
    scope: "preview",
    worktree: workspace,
  });
  const timeouts = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.timeoutMs]),
  );
  // The service may stretch a call up to its ceiling (a long wait asked by
  // the agent); the agent always waits past it.
  for (const name of ["click", "wait_for"]) {
    assert.ok(
      timeouts[`preview_devtools__${name}`]! > previewDevtoolsMaxTimeoutMs,
    );
    assert.ok(
      timeouts[`preview_devtools__${name}`]! >
        previewDevtoolsToolTimeoutMs(name, {
          arguments: { timeout: 10_000_000 },
        }),
    );
  }
});

async function readyPreviewOptions(
  worktree: string,
  call: () => never,
): Promise<PreviewToolServices> {
  const revisions = await currentWorkspaceRevisionState(worktree);
  return {
    previewDevtools: async () => ({
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
    previewDevtoolsCall: async () => call(),
    previewDevtoolsTools: async () => [
      { name: "click", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

test("a story in the project folder checks and starts the project's app through Blame", async () => {
  const calls: unknown[] = [];
  const options: PreviewToolServices = {
    projectApp: async (input) => {
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
  await json(tool!, { action: "start" });
  await json(tool!);
  assert.deepEqual(calls, [
    { action: "start", worktree: "/p" },
    { action: "status", worktree: "/p" },
  ]);
});

test("a direct story gets the project app tool, not the managed container's", async () => {
  const options: PreviewToolServices = {
    previewContainerLogs: async () => ({}),
    previewDevtools: async () => undefined,
    projectApp: async () => ({}),
    repairPreviewInitialization: async () => ({
      classification: "",
      reason: "",
      status: "unavailable" as const,
    }),
  };
  const names = async (workspaceMode: "direct" | "local-container") =>
    (
      await previewClientTools(options, {
        scope: "s",
        workspaceMode,
        worktree: "/p",
      })
    ).map((tool) => tool.name);
  const direct = await names("direct");
  assert.ok(direct.includes("project_app"));
  assert.ok(direct.includes("get_preview_devtools"));
  assert.ok(!direct.includes("repair_preview_initialization"));
  assert.ok(!direct.includes("get_preview_container_logs"));
  const isolated = await names("local-container");
  assert.ok(!isolated.includes("project_app"));
  assert.ok(isolated.includes("repair_preview_initialization"));
});

test("a long DevTools result is cut to its own limit, with a way to narrow it", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-limit-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const options = await readyPreviewOptions(workspace, () => {
    throw new Error("unused");
  });
  const snapshot = Array.from(
    { length: 5_000 },
    (_, index) => `- button "Item ${index}" [ref=e${index}]`,
  ).join("\n");
  options.previewDevtoolsCall = async () => ({
    content: [{ type: "text", text: snapshot }],
  });
  const tools = await previewDevtoolsMcpTools(options, {
    scope: "preview-limit",
    worktree: workspace,
  });
  const result = (await json(tools[0]!, {}, "session-limit")) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content.map((part) => part.text).join("\n");
  assert.ok(text.length < 41_000);
  assert.ok(text.startsWith('- button "Item 0" [ref=e0]'));
  assert.match(text, /\[Cut to 40000 characters: .* Narrow the call/u);
});

test("container logs keep their latest lines within the limit", async () => {
  const stdout = Array.from(
    { length: 4_000 },
    (_, index) => `request ${index} served`,
  ).join("\n");
  const tool = previewContainerLogsTool(
    {
      previewContainerLogs: async () => ({
        service: "web",
        source: "container",
        stdout,
        stderr: "warning\n",
      }),
    },
    { scope: "logs", worktree: "/p" },
  )!;
  const result = (await json(tool)) as Record<string, string>;
  assert.equal(result.service, "web");
  assert.equal(result.stderr, "warning\n");
  assert.ok(result.stdout!.length < 24_300);
  assert.ok(result.stdout!.endsWith("request 3999 served"));
  assert.match(
    result.stdout!,
    /^\[Cut to 24000 characters: the first \d+ of \d+ are omitted\. The latest lines are kept\./u,
  );
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

  const result = await json(tool!);

  assert.equal(worktree, "/tmp/story");
  assert.deepEqual(result, {
    classification: "repairable_initialization",
    reason: "A database service was introduced.",
    status: "applied",
  });
});

test("offers the selected surface tool without browser tools", async () => {
  const context: PreviewRuntimeContext = { worktree: "/work", storyId: "s" };
  const calls: unknown[] = [];
  const options: PreviewToolServices = {
    previewSurfaceInfo: async () => ({
      type: "terminal" as const,
      serviceId: "cli",
    }),
    previewSurfaceCall: async (input) => {
      calls.push(input);
      return { status: "ready", text: "hello" };
    },
  };
  const tools = await previewClientTools(options, context);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["preview_terminal"],
  );
  assert.equal(
    previewDevtoolsTool(options, { ...context, surface: { type: "terminal" } }),
    undefined,
  );
  await tools[0]!.run({ action: "read" } as never, toolContext());
  assert.equal(calls.length, 1);
});

test("surface tool arguments cannot bypass bounds", () => {
  assert.throws(() => boundedSurfaceArguments({ pattern: "x".repeat(201) }));
  assert.throws(() => boundedSurfaceArguments({ timeoutMs: 60001 }));
  assert.throws(() => boundedSurfaceArguments({ text: "x".repeat(71000) }));
});

test("lists key statuses and forwards a request, never a value", async () => {
  const preview = { worktree: "/worktrees/story-1", storyId: "US-1" };
  const calls: PreviewEnvironmentToolInput[] = [];
  const tool = previewEnvironmentTool(
    {
      previewEnvironment: async (input) => {
        calls.push(input);
        return input.action === "list"
          ? {
              action: "list",
              variables: [
                {
                  key: "STRIPE_SECRET_KEY",
                  status: "missing",
                  services: ["api"],
                },
              ],
            }
          : { action: "request", requested: input.key };
      },
    },
    preview,
  )!;
  assert.equal(tool.name, "preview_environment");
  assert.deepEqual(await json(tool, { action: "list" }), {
    action: "list",
    variables: [
      { key: "STRIPE_SECRET_KEY", status: "missing", services: ["api"] },
    ],
  });
  await json(tool, {
    action: "request",
    key: "STRIPE_SECRET_KEY",
    reason: "Checkout calls Stripe.",
    serviceId: "api",
  });
  assert.deepEqual(calls[1], {
    ...preview,
    action: "request",
    key: "STRIPE_SECRET_KEY",
    reason: "Checkout calls Stripe.",
    serviceId: "api",
  });
  const refused = await json(tool, {
    action: "request",
    key: "BAD KEY",
    reason: "",
  });
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 2);
  assert.equal(previewEnvironmentTool({}, preview), undefined);
});

test("a DevTools screenshot reaches the model as an image, its reference as text", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "blame-preview-image-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const options = await readyPreviewOptions(workspace, () => {
    throw new Error("unused");
  });
  const id = "a".repeat(64);
  options.previewDevtoolsTools = async () => [
    {
      name: "take_screenshot",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
  options.previewDevtoolsCall = async () => ({
    content: [
      { type: "text", text: `Screenshot saved as screenshot:${id}.` },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    _meta: {
      blameScreenshots: [
        {
          id,
          mimeType: "image/png",
          width: 10,
          height: 10,
          pageUrl: "http://app",
        },
      ],
    },
  });
  const tools = await previewDevtoolsMcpTools(options, {
    scope: "preview-image",
    worktree: workspace,
  });
  assert.equal(tools[0]!.effect, "read_only");
  const result = await callThroughToolSet(
    tools,
    "preview_devtools__take_screenshot",
    {},
  );
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.content[0], {
    type: "text",
    text: `Screenshot saved as screenshot:${id}.`,
  });
  assert.equal(result.content[1]!.type, "image");
  assert.deepEqual(result.blobs, [
    { media_type: "image/png", data: "iVBORw0KGgo=" },
  ]);
});
