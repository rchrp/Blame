// The orchestrator's tools against the story service and an account in
// memory (no engine): each refusal the host enforces whatever the prompt
// says, the epic's branch, the stories it creates, the approvals asked
// before launching, and the queue's gate for a paused or spent epic.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EngineClient } from "@blame/engine-client";
import type { Epic, OrchestratorSettings } from "../protocol.js";
import {
  fakeApi,
  fakeHost,
  preferences,
  row,
  service,
  settle,
  sync,
  type Row,
  type Status,
} from "../stories/stories-fakes.test.js";
import { Orchestrator } from "./service.js";

const epicId = "epic-1";
const session = "orchestrator-1";

const ranking = {
  generatedAt: "2026-11-21T00:00:00Z",
  benchmarkBoundary: 3,
  profile: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    sampleCount: 1,
  },
  all: [
    {
      providerId: "anthropic",
      modelId: "cheap",
      position: 0,
      segment: "benchmarked",
      estimatedCost: 1,
      smartScore: 10,
    },
    {
      providerId: "anthropic",
      modelId: "middle",
      position: 1,
      segment: "benchmarked",
      estimatedCost: 2,
      smartScore: 20,
    },
    {
      providerId: "anthropic",
      modelId: "smart",
      position: 2,
      segment: "benchmarked",
      estimatedCost: 3,
      smartScore: 30,
    },
  ],
  byProvider: {},
};

type Setup = {
  rows?: Row[];
  epic?: Partial<Epic>;
  /** The project's preview environment is ready (stories run in worktrees). */
  environment?: boolean;
  owned?: Record<string, string | null>;
  statuses?: Record<string, Partial<Status> & Record<string, unknown>>;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function desk(setup: Setup = {}) {
  const api = fakeApi(setup.rows ?? []);
  const epics = new Map<string, Epic>();
  const epic: Epic = {
    id: epicId,
    projectId: "a",
    title: "Checkout flow",
    goal: "Let people pay.",
    status: "active",
    branch: null,
    targetBranch: null,
    engineSessionId: null,
    settings: {},
    mergedAt: null,
    mergeCommit: null,
    ...setup.epic,
  };
  epics.set(epic.id, epic);
  let created = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify({ data: value }), { status });
    const one = /^\/projects\/epics\/([^/]+)$/.exec(path);
    if (one) {
      const known = epics.get(one[1]!);
      if (!known) return new Response("{}", { status: 404 });
      if (method === "PATCH")
        Object.assign(known, JSON.parse(String(init!.body)));
      return json({ ...known });
    }
    if (path === "/projects/epics")
      return json(
        [...epics.values()].filter(
          (item) => item.projectId === searchParams.get("projectId"),
        ),
      );
    if (path === "/projects/user-stories" && method === "POST") {
      created += 1;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      const story = {
        id: `new-${created}`,
        storyNumber: 10 + created,
        createdAt: new Date(Date.now() + created).toISOString(),
        ...body,
      } as unknown as Row;
      api.stories.set(story.id, story);
      return json(story);
    }
    if (/^\/projects\/[^/]+\/initialization$/.test(path))
      return json({
        initialization:
          setup.environment === false
            ? null
            : {
                status: "done",
                previewManifest: { services: [] },
                runConfigurations: [],
                createdAt: "2026-11-21T00:00:00Z",
                updatedAt: null,
              },
        practices: [],
      });
    return inner(url, init);
  }) as typeof fetch;
  cleanups.push(() => {
    api.restore();
  });

  const fake = fakeHost();
  for (const [id, status] of Object.entries(setup.statuses ?? {}))
    fake.statuses.set(id, {
      session: id,
      exists: true,
      running: false,
      turnRunning: false,
      turns: 1,
      models: [],
      ...status,
    } as Status);
  const call = fake.host.call;
  const host = {
    ...fake.host,
    call: async (method: string, input: unknown) =>
      method === "providers"
        ? { providers: [], connected: [], recommendations: ranking }
        : call(method as never, input),
    holds: (story: never) => orchestrator.holds(story),
  };
  const stories = await service(host as never, setup.owned ?? {});
  cleanups.push(() => stories.close());
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const branches = new Set(["main"]);
  const gitCalls: string[][] = [];
  const git = async (_cwd: string, args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (branches.has(args[3]!.replace("refs/heads/", ""))) return "sha\n";
      throw new Error("unknown revision");
    }
    if (args[0] === "branch") branches.add(args[1]!);
    if (args[0] === "diff") return "M\tsrc/cart.ts\nA\tsrc/pay.ts\n";
    if (args[0] === "ls-files") return "notes.md\n";
    return "";
  };
  const noRecords = {
    readRecords: async ({ session: id }: { session: string }) => {
      throw new Error(`session ${id} does not exist`);
    },
  } as unknown as EngineClient;
  const orchestrator: Orchestrator = new Orchestrator(
    {
      api: fake.host.api,
      stories: stories.service,
      call: host.call as never,
      client: async () => noRecords,
      git,
      emit: () => undefined,
    },
    { stateFile: join(directory, "epics.json"), tickMs: 3_600_000 },
  );
  cleanups.push(() => orchestrator.stop());
  await sync(stories.service, [{ id: "a", path: "/a" }], "window", {
    ...preferences,
    runMode: "local-container",
  });
  const settings: OrchestratorSettings = {
    workspace: { root: "/a", location: "host" },
    projectId: "a",
    epicId: epic.id,
    model: { providerId: "anthropic", modelId: "claude" },
  };
  await orchestrator.prepareSession(session, settings);
  const tools = new Map(
    orchestrator.tools(session, epic.id).map((tool) => [tool.name, tool]),
  );
  const run = async (name: string, input: Record<string, unknown>) => {
    const output = (await tools.get(name)!.run(input as never, {
      session,
      turn: "turn",
      call: "call",
      signal: new AbortController().signal,
      progress: () => undefined,
    })) as { json?: unknown } | string;
    return typeof output === "string"
      ? output
      : (output.json as Record<string, unknown>);
  };
  const report = async (name: string, input: Record<string, unknown>) => {
    const answer = await run(name, input);
    assert.equal(typeof answer, "object");
    return answer as Record<string, unknown>;
  };
  return {
    report,
    api,
    fake,
    epic,
    epics,
    orchestrator,
    stories: stories.service,
    run,
    branches,
    gitCalls,
  };
}

const inReview = (id: string, fields: Record<string, unknown> = {}) =>
  row(id, "a", {
    epicId,
    status: "in-review",
    engineSessionId: `session-${id}`,
    worktree: `/w/${id}`,
    branch: `story/${id}`,
    workspaceMode: "cloud-mirror",
    baseCommit: "base",
    ...fields,
  });

describe("the orchestrator's tools", () => {
  it("makes the epic's branch from the folder's branch and writes it to the epic", async () => {
    const { epic, branches, epics, orchestrator, fake } = await desk();
    assert.equal(epic.branch, "epic/checkout-flow");
    assert.equal(epic.targetBranch, "main");
    assert.equal(epic.engineSessionId, session);
    assert.ok(branches.has("epic/checkout-flow"));
    // A second epic of the same title gets a name of its own.
    const second = {
      ...epic,
      id: "epic-2",
      branch: null,
      targetBranch: null,
      engineSessionId: null,
    };
    epics.set(second.id, second);
    await orchestrator.prepareSession("orchestrator-2", {
      workspace: { root: "/a", location: "host" },
      projectId: "a",
      epicId: second.id,
      model: { providerId: "anthropic", modelId: "claude" },
    });
    assert.equal(second.branch, "epic/checkout-flow-2");
    // Its conversation cannot be replaced by another one while it exists.
    fake.statuses.set(session, {
      session,
      exists: true,
      running: false,
      turns: 1,
      models: [],
    });
    await assert.rejects(
      orchestrator.prepareSession("orchestrator-3", {
        workspace: { root: "/a", location: "host" },
        projectId: "a",
        epicId,
        model: { providerId: "anthropic", modelId: "claude" },
      }),
      /already has its conversation/,
    );
  });

  it("creates stories on the epic's branch, ordered by what they start after, with the model their intent gives", async () => {
    const { run, api } = await desk();
    const answer = await run("create_stories", {
      reason: "Two steps.",
      stories: [
        {
          key: "pay",
          title: "Pay",
          brief: "Add payment.",
          intent: "smarter",
          startsAfter: ["cart"],
        },
        {
          key: "cart",
          title: "Cart",
          brief: "Add the cart.",
          intent: "balanced",
        },
      ],
    });
    const created = (
      answer as { created: Array<{ key: string; id: string; model: string }> }
    ).created;
    assert.deepEqual(
      created.map((item) => item.key),
      ["cart", "pay"],
    );
    const cart = api.stories.get(created[0]!.id)!;
    const pay = api.stories.get(created[1]!.id)!;
    assert.equal(cart.epicId, epicId);
    assert.equal(cart.targetBranch, "epic/checkout-flow");
    assert.equal(cart.modelIntent, "balanced");
    assert.deepEqual(cart.requestedModel, {
      providerId: "anthropic",
      modelId: "middle",
    });
    assert.deepEqual(pay.requestedModel, {
      providerId: "anthropic",
      modelId: "smart",
    });
    assert.deepEqual(pay.startsAfter, [cart.id]);
    assert.equal(cart.runMode, "local-container");
  });

  it("refuses an unknown dependency, a cycle, and stories that would run Direct", async () => {
    const { run } = await desk();
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [
          {
            key: "a",
            title: "A",
            brief: "b",
            intent: "cheaper",
            startsAfter: ["ghost"],
          },
        ],
      }),
      /neither a key of this call nor a story of the epic/,
    );
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [
          {
            key: "a",
            title: "A",
            brief: "b",
            intent: "cheaper",
            startsAfter: ["b"],
          },
          {
            key: "b",
            title: "B",
            brief: "b",
            intent: "cheaper",
            startsAfter: ["a"],
          },
        ],
      }),
      /cycle/,
    );
    const direct = await desk({ environment: false });
    await assert.rejects(
      direct.run("create_stories", {
        reason: "r",
        stories: [{ key: "a", title: "A", brief: "b", intent: "cheaper" }],
      }),
      /no working preview environment/,
    );
    // Held, it waits in the backlog: nothing would run yet.
    await direct.run("create_stories", {
      reason: "r",
      stories: [
        { key: "a", title: "A", brief: "b", intent: "cheaper", hold: true },
      ],
    });
  });

  it("refuses to approve a story that is not in review, or whose last turn the harness did not verify", async () => {
    const { run } = await desk({
      rows: [
        row("s1", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Paused",
          engineSessionId: "session-s1",
          worktree: "/w/s1",
        }),
        inReview("s2"),
      ],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: {
        "session-s2": {
          lastOutcome: {
            status: "contract_unmet",
            unmet: [{ kind: "result", tool: "finish_task" }],
            refused: { kind: "failing_checks", tasks: ["build"] },
          },
        } as never,
      },
    });
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s1" }),
      /not in review/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s2" }),
      /did not end completed \(contract_unmet: build still fail\)/,
    );
  });

  it("approves and merges a story the harness verified", async () => {
    const { run, api } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": { lastOutcome: { status: "completed" } } as never,
      },
    });
    const answer = await run("approve_story", {
      reason: "Verified.",
      storyId: "s1",
    });
    assert.equal((answer as { merged: boolean }).merged, true);
    assert.equal(api.stories.get("s1")!.status, "done");
  });

  it("refuses a fourth request for changes on one story", async () => {
    const { run, report: read } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": { lastOutcome: { status: "completed" } } as never,
      },
    });
    for (let request = 1; request <= 3; request += 1) {
      const answer = await run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "changes",
        message: `Fix ${request}.`,
      });
      assert.equal(
        (answer as { changesRequested: number }).changesRequested,
        request,
      );
    }
    await assert.rejects(
      run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "changes",
        message: "Fix 4.",
      }),
      /already had 3 requests for changes/,
    );
    // An answer is not a request for changes.
    await run("message_story", {
      reason: "r",
      storyId: "s1",
      kind: "answer",
      message: "Use cents.",
    });
  });

  it("refuses to sleep while nothing of the epic works or can start", async () => {
    const waiting = await desk({
      rows: [
        inReview("s1"),
        // It waits for s1, which waits for the orchestrator: it cannot start.
        row("s2", "a", {
          epicId,
          status: "ready",
          startsAfter: ["s1"],
          storyNumber: 2,
        }),
      ],
    });
    await assert.rejects(
      waiting.run("end_turn", { action: "wait", reason: "r" }),
      /Nothing of the epic works or can start/,
    );
    const working = await desk({
      rows: [
        row("s1", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Running",
          engineSessionId: "session-s1",
          worktree: "/w/s1",
        }),
      ],
    });
    assert.match(
      String(await working.run("end_turn", { action: "wait", reason: "r" })),
      /Waiting/,
    );
  });

  it("refuses to finish while a story is neither merged nor rejected", async () => {
    const open = await desk({
      rows: [inReview("s1"), row("s2", "a", { epicId, status: "done" })],
    });
    await assert.rejects(
      open.run("end_turn", { action: "finish", reason: "r", summary: "Done." }),
      /Not every story is merged or rejected: US-001 \(in-review\)/,
    );
    const closed = await desk({
      rows: [
        row("s1", "a", { epicId, status: "done" }),
        row("s2", "a", { epicId, status: "discarded" }),
      ],
    });
    assert.match(
      String(
        await closed.run("end_turn", {
          action: "finish",
          reason: "r",
          summary: "Done.",
        }),
      ),
      /Finished/,
    );
  });

  it("refuses any start or message once the budget is spent, and holds the epic's queued stories", async () => {
    const { run, orchestrator, stories } = await desk({
      epic: { settings: { budgetMicroUsd: 1_000 } },
      rows: [
        inReview("s1"),
        row("s2", "a", { epicId, status: "backlog", storyNumber: 2 }),
      ],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": {
          lastOutcome: { status: "completed" },
          spentMicroUsd: 2_500,
        } as never,
      },
    });
    const state = await orchestrator.epicState(epicId);
    assert.equal(state.spend.spent, true);
    assert.equal(state.spend.storiesMicroUsd, 2_500);
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [{ key: "a", title: "A", brief: "b", intent: "cheaper" }],
      }),
      /budget is spent \(\$0\.00 of \$0\.00\)|budget is spent/,
    );
    await assert.rejects(
      run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "answer",
        message: "Go on.",
      }),
      /budget is spent/,
    );
    await assert.rejects(
      run("update_story", { reason: "r", storyId: "s2", queue: true }),
      /budget is spent/,
    );
    // A story queued before still does not start.
    const queued = stories
      .epicStories(epicId)
      .find((story) => story.id === "s2")!;
    assert.equal(orchestrator.holds({ ...queued, status: "ready" }), true);
  });

  it("holds a paused epic's queued stories and lets them go once it resumes", async () => {
    const { orchestrator, epics, stories, fake } = await desk({
      epic: { status: "paused" },
    });
    const story = { ...row("s9", "a", { epicId }), status: "ready" } as never;
    assert.equal(orchestrator.holds(story), true);
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    assert.equal(orchestrator.holds(story), false);
    void stories;
    void fake;
  });

  it("holds the queued stories of an epic whose conversation runs on another computer", async () => {
    const { orchestrator } = await desk();
    const elsewhere = {
      ...row("s9", "a", { epicId: "epic-elsewhere" }),
      status: "ready",
    } as never;
    assert.equal(orchestrator.holds(elsewhere), true);
    const outside = { ...row("s8", "a"), status: "ready" } as never;
    assert.equal(orchestrator.holds(outside), false);
  });

  it("refuses to sleep when the only queued story waits for the person", async () => {
    const { run, stories } = await desk({
      rows: [row("s1", "a", { epicId, status: "ready", requestedModel: null })],
    });
    // No agent model: the queue says it waits for one.
    await sync(stories, [{ id: "a", path: "/a" }], "window", {
      runMode: "local-container",
      premium: false,
      runtimePhase: "ready",
    });
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some((wait) => wait.reason.kind === "no-model"),
      "the story to wait for a model",
    );
    await assert.rejects(
      run("end_turn", { action: "wait", reason: "r" }),
      /Nothing of the epic works or can start/,
    );
  });

  it("asks the person before launching only when the epic says so", async () => {
    const ask = (orchestrator: Orchestrator, tool: string, input: unknown) =>
      orchestrator.approval({
        session,
        turn: "t",
        call: "c",
        tool: { name: tool } as never,
        input: input as never,
      });
    const free = await desk();
    assert.equal(
      await ask(free.orchestrator, "create_stories", { stories: [{}] }),
      "approved",
    );
    const asking = await desk({
      epic: { settings: { askBeforeLaunch: true } },
    });
    assert.equal(
      await ask(asking.orchestrator, "create_stories", {
        stories: [{ hold: true }, {}],
      }),
      undefined,
    );
    assert.equal(
      await ask(asking.orchestrator, "create_stories", {
        stories: [{ hold: true }],
      }),
      "approved",
    );
    assert.equal(
      await ask(asking.orchestrator, "update_story", { storyId: "s" }),
      "approved",
    );
    assert.equal(
      await ask(asking.orchestrator, "update_story", {
        storyId: "s",
        queue: true,
      }),
      undefined,
    );
    assert.equal(
      await ask(asking.orchestrator, "approve_story", { storyId: "s" }),
      undefined,
    );
    // Another conversation is not the orchestrator's to answer.
    assert.equal(
      await asking.orchestrator.approval({
        session: "other",
        turn: "t",
        call: "c",
        tool: { name: "approve_story" } as never,
        input: {},
      }),
      undefined,
    );
  });

  it("reports a story's outcome, reply and changed files", async () => {
    const { run, report: read } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": {
          lastOutcome: { status: "completed" },
          lastReply: "Added payment.",
          turns: 2,
          spentMicroUsd: 1_200,
        } as never,
      },
    });
    const report = await read("story_report", { storyId: "US-001" });
    assert.equal(report.outcome, "completed");
    assert.equal(report.verified, true);
    assert.equal(report.reply, "Added payment.");
    assert.deepEqual(report.files, [
      { path: "src/cart.ts", change: "modified" },
      { path: "src/pay.ts", change: "added" },
      { path: "notes.md", change: "added" },
    ]);
    assert.equal(report.costMicroUsd, 1_200);
    await assert.rejects(
      run("story_report", { storyId: "elsewhere" }),
      /not a story of this epic/,
    );
  });

  it("changes a story that has not started, and refuses one that has", async () => {
    const { run, api } = await desk({
      rows: [
        row("s1", "a", { epicId, status: "backlog" }),
        row("s2", "a", { epicId, status: "backlog", storyNumber: 2 }),
        inReview("s3", { storyNumber: 3 }),
      ],
    });
    await run("update_story", {
      reason: "r",
      storyId: "s2",
      brief: "Better brief.",
      startsAfter: ["s1"],
      intent: "cheaper",
    });
    const edited = api.stories.get("s2")!;
    assert.equal(edited.summary, "Better brief.");
    assert.deepEqual(edited.startsAfter, ["s1"]);
    assert.deepEqual(edited.requestedModel, {
      providerId: "anthropic",
      modelId: "cheap",
    });
    await assert.rejects(
      run("update_story", { reason: "r", storyId: "s3", brief: "x" }),
      /has started/,
    );
    await run("update_story", { reason: "r", storyId: "s1", queue: true });
    await settle(
      () => api.stories.get("s1")!.status !== "backlog",
      "s1 to be queued",
    );
  });
});
