// The orchestrator's tools against the story service and an account in
// memory (no engine): each refusal the host enforces whatever the prompt
// says, the epic's branch, the stories it creates, the approvals asked
// before launching, the queue's gate, and what is kept across a relaunch
// or another account.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EngineClient } from "@blame/engine-client";
import {
  orchestratorWakeText,
  type Epic,
  type OrchestratorSettings,
} from "../protocol.js";
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
import { idleSignature, idleTold } from "./board.js";
import { parseEpic } from "./epics.js";
import { Orchestrator } from "./service.js";
import type { OrchestratorState } from "./state.js";
import { storyHandlers } from "../stories/handlers.js";

const epicId = "epic-1";
const session = "orchestrator-1";
const epicBranch = "epic/checkout-flow";

const ranked = (...ids: string[]) => ({
  generatedAt: "2026-11-21T00:00:00Z",
  benchmarkBoundary: 3,
  profile: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    sampleCount: 1,
  },
  all: ids.map((modelId, index) => ({
    providerId: "anthropic",
    modelId,
    position: index,
    segment: "benchmarked" as const,
    estimatedCost: index + 1,
    smartScore: (index + 1) * 10,
  })),
  byProvider: {},
});

type Setup = {
  rows?: Row[];
  epic?: Partial<Epic>;
  /** The project's preview environment is ready (stories run in worktrees). */
  environment?: boolean;
  owned?: Record<string, string | null>;
  statuses?: Record<string, Partial<Status> & Record<string, unknown>>;
  /** The ranking's models (cheap, middle, smart by default). */
  ranking?: string[];
  /** The account's agent model, as the windows give it. */
  agentModel?: { providerId: string; modelId: string } | null;
  /** Branches the project already has. */
  branches?: string[];
  /** The state file of an earlier run (a relaunch). */
  stateFile?: string;
  /** Approve & Merge conflicts. */
  conflict?: boolean;
  /** Starting a story's worktree fails. */
  failStart?: boolean;
  stuckStartMs?: number;
  /** Sessions whose interrupt fails once. */
  failInterrupt?: string[];
  /** Sessions whose interrupt never answers (Blame quits meanwhile). */
  hangInterrupt?: string[];
  /** The engine does not answer. */
  noEngine?: boolean;
  /** No conversation is created (a relaunch reads what is kept). */
  prepare?: boolean;
  /** The conversation's records, as the engine has them (more may be pushed). */
  records?: Array<Record<string, unknown>>;
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
      if (!known)
        return new Response(JSON.stringify({ message: "Row not found" }), {
          status: 404,
        });
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
  // `gate`, while set, holds each attempt open until it settles; `send`
  // holds each message to a story's agent the same way.
  const starts: { count: number; gate?: Promise<void>; send?: Promise<void> } =
    { count: 0 };
  const sends: string[] = [];
  if (setup.failStart)
    fake.host.desktop.createStoryWorktree = async () => {
      starts.count += 1;
      await starts.gate;
      throw new Error("the epic's branch is gone");
    };
  const failInterrupt = new Set(setup.failInterrupt ?? []);
  const call = fake.host.call;
  const host = {
    ...fake.host,
    call: async (method: string, input: unknown) => {
      if (method === "providers")
        return {
          providers: [],
          connected: [],
          recommendations: ranked(
            ...(setup.ranking ?? ["cheap", "middle", "smart"]),
          ),
        };
      const target = (input as { session?: string } | undefined)?.session;
      if (method === "send" && target) {
        sends.push(target);
        await starts.send;
      }
      if (method === "interrupt" && target && failInterrupt.delete(target))
        throw new Error("The agent engine did not answer.");
      if (method === "interrupt" && setup.hangInterrupt?.includes(target ?? ""))
        await new Promise(() => undefined);
      if (method === "approveAndMerge" && setup.conflict) {
        const error = new Error(
          "Merging epic/checkout-flow into the story conflicts in src/cart.ts.",
        );
        error.name = "StoryMergeConflictError";
        Object.assign(error, { files: ["src/cart.ts"] });
        throw error;
      }
      return call(method as never, input);
    },
    holds: (story: never) => orchestrator.holds(story),
  };
  const stories = await service(host as never, setup.owned ?? {});
  cleanups.push(() => stories.close());
  const directory = await mkdtemp(join(tmpdir(), "orchestrator-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const stateFile = setup.stateFile ?? join(directory, "epics.json");
  const branches = new Set(["main", ...(setup.branches ?? [])]);
  const git = async (_cwd: string, args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (branches.has(args[3]!.replace("refs/heads/", ""))) return "sha\n";
      throw new Error("unknown revision");
    }
    if (args[0] === "for-each-ref") return [...branches].join("\n");
    if (args[0] === "branch") branches.add(args[1]!);
    if (args[0] === "diff") return "M\tsrc/cart.ts\nA\tsrc/pay.ts\n";
    if (args[0] === "ls-files") return "notes.md\n";
    return "";
  };
  const noRecords = {
    readRecords: async ({
      session: id,
      after = 0,
    }: {
      session: string;
      after?: number;
    }) => {
      if (id !== session || !setup.records)
        throw new Error(`session ${id} does not exist`);
      return {
        records: setup.records.filter((record) => Number(record.seq) > after),
        head: setup.records.length,
      };
    },
  } as unknown as EngineClient;
  const written: unknown[] = [];
  const interrupted: string[] = [];
  const orchestrator: Orchestrator = new Orchestrator(
    {
      api: fake.host.api,
      stories: stories.service,
      call: host.call as never,
      write: async (input) => {
        written.push(input);
      },
      interrupt: async (id) => {
        interrupted.push(id);
      },
      client: async () => {
        if (setup.noEngine) throw new Error("The agent engine did not answer.");
        return noRecords;
      },
      git,
      emit: () => undefined,
    },
    {
      stateFile,
      tickMs: 3_600_000,
      ...(setup.stuckStartMs !== undefined
        ? { stuckStartMs: setup.stuckStartMs }
        : {}),
    },
  );
  cleanups.push(() => orchestrator.stop());
  await sync(stories.service, [{ id: "a", path: "/a" }], "window", {
    ...preferences,
    ...(setup.agentModel === null
      ? { agentModel: undefined }
      : setup.agentModel
        ? { agentModel: setup.agentModel }
        : {}),
    runMode: "local-container",
  });
  const settings: OrchestratorSettings = {
    workspace: { root: "/a", location: "host" },
    projectId: "a",
    epicId: epic.id,
    model: { providerId: "anthropic", modelId: "claude" },
  };
  if (setup.prepare !== false)
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
    stateFile,
    written,
    interrupted,
    settings,
    starts,
    sends,
  };
}

// The conversation's records from `after`, numbered as the engine numbers them.
const conversation = (bodies: Array<Record<string, unknown>>, after = 0) =>
  bodies.map((body, index) => ({
    seq: after + index + 1,
    at_ms: 1_000 + after + index,
    ...body,
  }));
const text = (value: string) => [{ type: "text", text: value }];
// A wake that told s1's turn a1, as the host writes it.
const queuedWake = [
  {
    type: "context",
    text: orchestratorWakeText({
      reason: "stories",
      stories: [
        {
          storyId: "s1",
          number: "US-001",
          title: "a",
          session: "session-s1",
          turn: "a1",
          outcome: "completed",
          verified: true,
          status: "in-review",
        },
      ],
      board: {
        working: 0,
        queued: 0,
        held: 0,
        inReview: 1,
        paused: 0,
        merged: 0,
        rejected: 0,
      },
    }),
  },
];
const endedA1 = {
  lastOutcome: { status: "completed" },
  endedTurns: [{ turn: "a1", outcome: { status: "completed" } }],
} as never;
const requestStarted = (turn: string) => ({
  type: "request_started",
  turn,
  request: `r-${turn}`,
  model: { provider: "anthropic", model: "claude" },
  attempt: 1,
  prefix_digest: "sha256:0",
});

const inReview = (id: string, fields: Record<string, unknown> = {}) =>
  row(id, "a", {
    epicId,
    status: "in-review",
    engineSessionId: `session-${id}`,
    worktree: `/w/${id}`,
    branch: `story/${id}`,
    targetBranch: epicBranch,
    workspaceMode: "cloud-mirror",
    runMode: "vercel-compose",
    baseCommit: "base",
    ...fields,
  });
const verified = { lastOutcome: { status: "completed" } } as Record<
  string,
  unknown
> as never;
const verifiedFields = { lastOutcome: { status: "completed" } };
const newStory = (fields: Record<string, unknown> = {}) => ({
  key: "a",
  title: "A",
  brief: "Do A.",
  intent: "cheaper",
  ...fields,
});

describe("the epic's branch", () => {
  it("is made from the folder's branch and written to the epic; another epic of the same title gets its own", async () => {
    const { epic, branches, epics, orchestrator, fake } = await desk();
    assert.equal(epic.branch, epicBranch);
    assert.equal(epic.targetBranch, "main");
    assert.equal(epic.engineSessionId, session);
    assert.ok(branches.has(epicBranch));
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

  it("never collides with a branch git cannot hold beside it, even when two are made at once", async () => {
    const taken = await desk({ branches: ["epic"] });
    assert.equal(taken.epic.branch, "epic-checkout-flow");
    const nested = await desk({ branches: ["epic/checkout-flow/old"] });
    assert.equal(nested.epic.branch, "epic/checkout-flow-2");
    const twice = await desk({ prepare: false });
    const other = { ...twice.epic, id: "epic-2" };
    twice.epics.set(other.id, other);
    await Promise.all([
      twice.orchestrator.prepareSession("s1", twice.settings),
      twice.orchestrator.prepareSession("s2", {
        ...twice.settings,
        epicId: other.id,
      }),
    ]);
    assert.notEqual(twice.epic.branch, other.branch);
  });

  it("refuses a branch the API names that this computer did not make, or one equal to the target", async () => {
    const foreign = await desk({ prepare: false, epic: { branch: "main" } });
    await assert.rejects(
      foreign.orchestrator.prepareSession(session, foreign.settings),
      /did not make for it/,
    );
    const ours = await desk();
    // The API now says another branch: nothing merges, nothing starts.
    ours.epic.branch = "main";
    await assert.rejects(
      ours.run("create_stories", { reason: "r", stories: [newStory()] }),
      /not the one this computer made/,
    );
  });

  it("takes an unknown status as held, never as free to run", () => {
    assert.equal(
      parseEpic({ id: "e", projectId: "p", status: "reviewing" }).status,
      "paused",
    );
  });
});

describe("creating and changing stories", () => {
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
    const created = (answer as { created: Array<{ key: string; id: string }> })
      .created;
    assert.deepEqual(
      created.map((item) => item.key),
      ["cart", "pay"],
    );
    const cart = api.stories.get(created[0]!.id)!;
    const pay = api.stories.get(created[1]!.id)!;
    assert.equal(cart.epicId, epicId);
    assert.equal(cart.targetBranch, epicBranch);
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

  it("refuses a missing or repeated key, an unknown or rejected dependency, a cycle, and stories that would run Direct", async () => {
    const { run } = await desk({
      rows: [row("gone", "a", { epicId, status: "discarded", storyNumber: 5 })],
    });
    await assert.rejects(
      run("create_stories", { reason: "r", stories: [newStory({ key: "" })] }),
      /A story has no key\./,
    );
    await assert.rejects(
      run("create_stories", { reason: "r", stories: [newStory(), newStory()] }),
      /Two stories use the key a/,
    );
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [newStory({ startsAfter: ["ghost"] })],
      }),
      /neither a key of this call nor a story of the epic/,
    );
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [newStory({ startsAfter: ["gone"] })],
      }),
      /US-005, which was rejected/,
    );
    await assert.rejects(
      run("create_stories", {
        reason: "r",
        stories: [
          newStory({ startsAfter: ["b"] }),
          newStory({ key: "b", startsAfter: ["a"] }),
        ],
      }),
      /cycle/,
    );
    const direct = await desk({ environment: false });
    await assert.rejects(
      direct.run("create_stories", { reason: "r", stories: [newStory()] }),
      /no working preview environment/,
    );
    await direct.run("create_stories", {
      reason: "r",
      stories: [newStory({ hold: true })],
    });
  });

  it("refuses when no model can run the stories, or only the account's on a provider the epic does not allow", async () => {
    const none = await desk({ ranking: [], agentModel: null });
    await assert.rejects(
      none.run("create_stories", { reason: "r", stories: [newStory()] }),
      /No model can run the stories/,
    );
    const disallowed = await desk({
      ranking: [],
      agentModel: { providerId: "openai", modelId: "gpt" },
      epic: { settings: { providers: ["anthropic"] } },
    });
    await assert.rejects(
      disallowed.run("create_stories", { reason: "r", stories: [newStory()] }),
      /No model of the providers the epic allows \(anthropic\)/,
    );
    // On an allowed provider, the account's model stands in.
    const allowed = await desk({
      ranking: [],
      agentModel: { providerId: "anthropic", modelId: "claude" },
      epic: { settings: { providers: ["anthropic"] } },
    });
    const answer = await allowed.report("create_stories", {
      reason: "r",
      stories: [newStory()],
    });
    assert.match(JSON.stringify(answer), /anthropic\/claude/);
  });

  it("changes a story that has not started, and refuses one that has, a dependency that is not another story, and a queue that would run Direct", async () => {
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
      /has already started, so it no longer changes/,
    );
    await assert.rejects(
      run("update_story", { reason: "r", storyId: "s2", startsAfter: ["s2"] }),
      /is not another story of the epic/,
    );
    await assert.rejects(
      run("update_story", {
        reason: "r",
        storyId: "s2",
        startsAfter: ["elsewhere"],
      }),
      /is not another story of the epic/,
    );
    await run("update_story", { reason: "r", storyId: "s1", queue: true });
    await settle(
      () => api.stories.get("s1")!.status !== "backlog",
      "s1 to be queued",
    );
    const direct = await desk({
      environment: false,
      rows: [row("s1", "a", { epicId, status: "backlog" })],
    });
    await assert.rejects(
      direct.run("update_story", { reason: "r", storyId: "s1", queue: true }),
      /no working preview environment/,
    );
  });
});

describe("judging stories", () => {
  it("refuses to approve a story not in review, at work, not run here, or whose last turn the harness did not verify", async () => {
    const { run } = await desk({
      rows: [
        row("s1", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Paused",
          engineSessionId: "session-s1",
          worktree: "/w/s1",
        }),
        inReview("s2", { storyNumber: 2 }),
        // Its merge runs now.
        inReview("s3", { storyNumber: 3, agentStatus: "Running" }),
        inReview("s4", { storyNumber: 4 }),
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
        "session-s3": verified,
        "session-s4": verified,
      },
    });
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s1" }),
      /not in review/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s2" }),
      /is not merged: the harness did not verify its work \(its last turn ended contract_unmet: build still fails\)/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s3" }),
      /agent is still working, so it cannot be approved yet/,
    );
    // s4 is not this computer's: its records are not here.
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s4" }),
      /agent ran on another computer, so its work cannot be judged here/,
    );
  });

  it("never merges anywhere but the epic's branch as this host made it, nor a story that ran Direct", async () => {
    const { run, api } = await desk({
      rows: [
        inReview("s1", { targetBranch: "main" }),
        inReview("s2", { storyNumber: 2, targetBranch: null }),
        inReview("s3", { storyNumber: 3, workspaceMode: "direct" }),
      ],
      owned: { s1: "session-s1", s2: "session-s2", s3: "session-s3" },
      statuses: {
        "session-s1": verified,
        "session-s2": verified,
        "session-s3": verified,
      },
    });
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s1" }),
      /is not merged: it would merge into main, not the epic's branch/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s2" }),
      /would merge into the project folder's branch/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s3" }),
      /is not merged: it ran Direct/,
    );
    assert.equal(api.stories.get("s1")!.status, "in-review");
  });

  it("approves and merges a story the harness verified", async () => {
    const { run, api } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": verified },
    });
    const answer = await run("approve_story", {
      reason: "Verified.",
      storyId: "s1",
    });
    assert.equal((answer as { merged: boolean }).merged, true);
    assert.equal(api.stories.get("s1")!.status, "done");
  });

  it("refuses a merge that conflicts, and says to send it back", async () => {
    const { run, api } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": verified },
      conflict: true,
    });
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s1" }),
      /is not merged: its changes conflict with what the epic's branch epic\/checkout-flow already has \(src\/cart\.ts\)\. Ask for changes .*git merge epic\/checkout-flow/,
    );
    assert.equal(api.stories.get("s1")!.status, "in-review");
  });

  it("counts any message to a story in review as a request for changes, three at most, and six messages in all", async () => {
    const review = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": verified },
    });
    for (let request = 1; request <= 3; request += 1) {
      const answer = await review.run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: request === 2 ? "answer" : "changes",
        message: `Fix ${request}.`,
      });
      assert.equal(
        (answer as { changesRequested: number }).changesRequested,
        request,
      );
      // The send made it work again: it is back in review for the next.
      Object.assign(review.api.stories.get("s1")!, {
        status: "in-review",
        agentStatus: null,
      });
      await review.stories.refresh("a");
    }
    await assert.rejects(
      review.run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "answer",
        message: "Fix 4.",
      }),
      /has had its 3 requests for changes/,
    );
    // Answers to a story at work are not changes, but are counted in all.
    const working = await desk({
      rows: [
        row("s1", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Paused",
          engineSessionId: "session-s1",
          worktree: "/w/s1",
          workspaceMode: "cloud-mirror",
        }),
      ],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": { lastOutcome: { status: "interrupted" } } as never,
      },
    });
    for (let answer = 1; answer <= 6; answer += 1) {
      await working.run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "answer",
        message: `Answer ${answer}.`,
      });
      Object.assign(working.api.stories.get("s1")!, {
        status: "in-progress",
        agentStatus: "Paused",
      });
      await working.stories.refresh("a");
    }
    await assert.rejects(
      working.run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "answer",
        message: "One more.",
      }),
      /has had its 6 messages from the orchestrator/,
    );
  });

  it("refuses to escalate a story already on the top of the range", async () => {
    const { run } = await desk({
      rows: [
        inReview("s1", {
          agentModels: [
            { providerId: "anthropic", modelId: "smart", turns: 1 },
          ],
        }),
      ],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": verified },
    });
    await assert.rejects(
      run("message_story", {
        reason: "r",
        storyId: "s1",
        kind: "changes",
        message: "Again.",
        escalate: true,
      }),
      /already runs on the smartest model/,
    );
  });

  it("refuses to reject a merged story", async () => {
    const { run } = await desk({
      rows: [row("s1", "a", { epicId, status: "done" })],
    });
    await assert.rejects(
      run("reject_story", { reason: "r", storyId: "s1" }),
      /is already merged into the epic's branch, so it stays/,
    );
  });

  it("reports a story's outcome, reply and changed files, and marks heard only the turn it showed", async () => {
    const { report, run, orchestrator } = await desk({
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": {
          lastOutcome: { status: "completed" },
          lastReply: "Added payment.",
          turns: 2,
          spentMicroUsd: 1_200,
          endedTurns: [
            { turn: "t1", outcome: { status: "interrupted" } },
            {
              turn: "t2",
              outcome: { status: "completed" },
              reply: "Added payment.",
            },
          ],
        } as never,
      },
    });
    assert.equal((await orchestrator.epicState(epicId)).unreported, 2);
    const answer = await report("story_report", { storyId: "US-001" });
    assert.equal(answer.outcome, "completed");
    assert.equal(answer.verified, true);
    assert.equal(answer.reply, "Added payment.");
    assert.deepEqual(answer.files, [
      { path: "src/cart.ts", change: "modified" },
      { path: "src/pay.ts", change: "added" },
      { path: "notes.md", change: "added" },
    ]);
    assert.equal(answer.costMicroUsd, 1_200);
    // It showed t2, not t1: t1 is still to tell.
    assert.equal((await orchestrator.epicState(epicId)).unreported, 1);
    await assert.rejects(
      run("story_report", { storyId: "elsewhere" }),
      /not a story of this epic/,
    );
  });
});

describe("ending a turn", () => {
  it("refuses to sleep while nothing of the epic works or will start by itself", async () => {
    const waiting = await desk({
      rows: [
        inReview("s1"),
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
      /cannot sleep: nothing of the epic is working or will start by itself/,
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

  it("refuses to sleep when the only queued story waits for the person", async () => {
    const { run, stories } = await desk({
      rows: [row("s1", "a", { epicId, status: "ready", requestedModel: null })],
      agentModel: null,
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
      /cannot sleep: nothing of the epic is working or will start by itself/,
    );
  });

  it("tells the person, and refuses to sleep, when a story's start keeps failing", async () => {
    const { run, stories, orchestrator } = await desk({
      rows: [
        row("s1", "a", { epicId, status: "ready", runMode: "local-container" }),
      ],
      failStart: true,
      stuckStartMs: 0,
    });
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some((wait) => wait.reason.kind === "error"),
      "the start to fail",
    );
    const state = await orchestrator.epicState(epicId);
    assert.match(
      state.blocked?.[0]?.reason ?? "",
      /its start keeps failing: the epic's branch is gone/,
    );
    await assert.rejects(
      run("end_turn", { action: "wait", reason: "r" }),
      /cannot sleep: nothing of the epic is working or will start by itself/,
    );
  });

  it("refuses to finish while a story is open, and ask or finish with nothing to say", async () => {
    const open = await desk({
      rows: [inReview("s1"), row("s2", "a", { epicId, status: "done" })],
    });
    await assert.rejects(
      open.run("end_turn", { action: "finish", reason: "r", summary: "Done." }),
      /The epic is not finished: US-001 \(in-review\) is neither merged nor rejected/,
    );
    const closed = await desk({
      rows: [
        row("s1", "a", { epicId, status: "done" }),
        row("s2", "a", { epicId, status: "discarded" }),
      ],
    });
    await assert.rejects(
      closed.run("end_turn", { action: "finish", reason: "r" }),
      /The epic's summary for the person is missing/,
    );
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
    await assert.rejects(
      closed.run("end_turn", { action: "ask", reason: "r" }),
      /The question for the person is missing/,
    );
  });
});

describe("the budget, the gate and what is kept", () => {
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
    await assert.rejects(
      run("create_stories", { reason: "r", stories: [newStory()] }),
      /budget is spent/,
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
    const queued = stories
      .epicStories(epicId)
      .find((story) => story.id === "s2")!;
    assert.deepEqual(orchestrator.holds({ ...queued, status: "ready" }), {
      kind: "epic",
      epicId,
      hold: "budget",
    });
  });

  it("holds a spent epic's stories after a relaunch, from what was kept", async () => {
    const first = await desk({
      epic: { settings: { budgetMicroUsd: 1_000 } },
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: {
        "session-s1": {
          lastOutcome: { status: "completed" },
          spentMicroUsd: 2_500,
        } as never,
      },
    });
    await first.orchestrator.epicState(epicId);
    first.orchestrator.stop();
    // A new run: the same file, no look at the epic's stories yet.
    const second = await desk({
      prepare: false,
      stateFile: first.stateFile,
      epic: { ...first.epic },
    });
    const story = { ...row("s9", "a", { epicId }), status: "ready" } as never;
    // Before the epic is read: held.
    assert.equal(second.orchestrator.holds(story)?.kind, "epic");
    await second.orchestrator.epic(epicId, true);
    // `unknown` until the kept file is read (the constructor reads it).
    await settle(
      () =>
        JSON.stringify(second.orchestrator.holds(story)) !==
        JSON.stringify({ kind: "epic", epicId, hold: "unknown" }),
      "the kept file to be read",
    );
    assert.deepEqual(second.orchestrator.holds(story), {
      kind: "epic",
      epicId,
      hold: "budget",
    });
  });

  it("keeps everything when the API does not show the epic (another account), and holds its stories", async () => {
    const { orchestrator, epics, epic, stateFile } = await desk();
    epics.delete(epicId);
    orchestrator.connected();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const kept = JSON.parse(await readFile(stateFile, "utf8")) as {
      epics: Record<string, { branch: string }>;
    };
    assert.equal(kept.epics[epicId]?.branch, epicBranch);
    const story = { ...row("s9", "a", { epicId }), status: "ready" } as never;
    assert.equal(orchestrator.holds(story)?.kind, "epic");
    // Back on the account that shows it: as before.
    epics.set(epicId, epic);
    await orchestrator.epic(epicId, true);
    assert.equal(orchestrator.holds(story), undefined);
  });

  it("holds a paused epic's stories, and an epic run on another computer, with the reason the queue shows", async () => {
    const { orchestrator, epics, stories } = await desk({
      epic: { status: "paused" },
      rows: [row("s1", "a", { epicId, status: "ready" })],
    });
    const story = { ...row("s9", "a", { epicId }), status: "ready" } as never;
    assert.deepEqual(orchestrator.holds(story), {
      kind: "epic",
      epicId,
      hold: "paused",
    });
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some(
            (wait) => wait.storyId === "s1" && wait.reason.kind === "epic",
          ),
      "the queue to say why",
    );
    // Held, so it does not start by itself, but not listed as needing the
    // person: the pause is theirs.
    assert.equal(orchestrator.blocked(stories.epicStories(epicId)[0]!), true);
    assert.equal((await orchestrator.epicState(epicId)).blocked, undefined);
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    assert.equal(orchestrator.holds(story), undefined);
    assert.deepEqual(
      orchestrator.holds({
        ...row("s8", "a", { epicId: "epic-elsewhere" }),
        status: "ready",
      } as never),
      { kind: "epic", epicId: "epic-elsewhere", hold: "elsewhere" },
    );
    assert.equal(
      orchestrator.holds({ ...row("s7", "a"), status: "ready" } as never),
      undefined,
    );
  });

  it("keeps an epic's story out of the person's folder when the preview environment broke after it was created", async () => {
    const { stories } = await desk({
      environment: false,
      rows: [
        row("s1", "a", { epicId, status: "ready", runMode: "local-container" }),
      ],
    });
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some(
            (wait) =>
              wait.storyId === "s1" &&
              wait.reason.kind === "epic" &&
              wait.reason.hold === "direct",
          ),
      "the story to wait instead of running Direct",
    );
  });

  it("pauses the epic's agents, and resumes exactly those", async () => {
    const { orchestrator, epics, api, fake, stories } = await desk({
      rows: [
        row("s1", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Running",
          engineSessionId: "session-s1",
          worktree: "/w/s1",
          workspaceMode: "cloud-mirror",
        }),
        // The person paused this one: it stays paused.
        row("s2", "a", {
          epicId,
          status: "in-progress",
          agentStatus: "Paused",
          engineSessionId: "session-s2",
          worktree: "/w/s2",
          workspaceMode: "cloud-mirror",
          storyNumber: 2,
        }),
      ],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: {
        "session-s1": { running: true, turnRunning: true } as never,
        "session-s2": { lastOutcome: { status: "interrupted" } } as never,
      },
    });
    const interrupts = () =>
      fake.calls
        .filter((item) => item.method === "interrupt")
        .map((item) => (item.input as { session: string }).session);
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    assert.deepEqual(interrupts(), ["session-s1"]);
    // Its turn ends paused, as the engine would; a later look pauses nothing more.
    Object.assign(api.stories.get("s1")!, { agentStatus: "Paused" });
    await stories.refresh("a");
    await orchestrator.changed(epicId);
    assert.deepEqual(interrupts(), ["session-s1"]);
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    const resumed = fake.calls
      .filter((item) => item.method === "send")
      .map((item) => (item.input as { session: string }).session);
    assert.deepEqual(resumed, ["session-s1"]);
  });

  it("answers approvals of its three tools only, and asks the person when the epic says so", async () => {
    const ask = (
      orchestrator: Orchestrator,
      tool: string,
      input: unknown,
      at = session,
    ) =>
      orchestrator.approval({
        session: at,
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
    assert.equal(
      await ask(free.orchestrator, "deploy_somewhere", {}),
      undefined,
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
    assert.equal(
      await ask(asking.orchestrator, "approve_story", {}, "other"),
      undefined,
    );
  });

  it("refuses to build a conversation's config for a session that is not the epic's", async () => {
    const { orchestrator, settings, epic } = await desk();
    await assert.rejects(
      orchestrator.resolve("another-session", settings),
      /not this epic's/,
    );
    // Even when the API forgot which session it is, this computer knows.
    epic.engineSessionId = null;
    await assert.rejects(
      orchestrator.resolve("another-session", settings),
      /not this epic's/,
    );
    const resolved = await orchestrator.resolve(session, settings);
    assert.equal(resolved.resolved.epic.branch, epicBranch);
  });
});

describe("what holds when things go wrong", () => {
  const running = (id: string, fields: Record<string, unknown> = {}) =>
    row(id, "a", {
      epicId,
      status: "in-progress",
      agentStatus: "Running",
      engineSessionId: `session-${id}`,
      worktree: `/w/${id}`,
      workspaceMode: "cloud-mirror",
      ...fields,
    });
  const runningTurn = { running: true, turnRunning: true } as never;
  const keptPause = async (file: string) =>
    (
      JSON.parse(await readFile(file, "utf8")) as {
        epics: Record<string, { pause?: { phase: string; stories: string[] } }>;
      }
    ).epics[epicId]?.pause;

  it("writes what the pause means to stop before it acts, and takes it up again after a failure or a quit", async () => {
    const first = await desk({
      rows: [running("s1"), running("s2", { storyNumber: 2 })],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: { "session-s1": runningTurn, "session-s2": runningTurn },
      failInterrupt: ["session-s2"],
    });
    first.epics.get(epicId)!.status = "paused";
    const state = await first.orchestrator.changed(epicId);
    // s2's interrupt failed: the pause still names it, and says so.
    assert.equal(state.pause?.phase, "pausing");
    assert.match(state.pause?.error ?? "", /did not answer/);
    assert.deepEqual((await keptPause(first.stateFile))?.stories.sort(), [
      "s1",
      "s2",
    ]);
    // Blame quits; a new run on the same file goes on with the pause.
    first.orchestrator.stop();
    const second = await desk({
      prepare: false,
      stateFile: first.stateFile,
      epic: { ...first.epic, status: "paused" },
      rows: [
        running("s1", { agentStatus: "Paused" }),
        running("s2", { storyNumber: 2 }),
      ],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: { "session-s2": runningTurn },
    });
    await second.orchestrator.changed(epicId);
    const interrupts = second.fake.calls
      .filter((item) => item.method === "interrupt")
      .map((item) => (item.input as { session: string }).session);
    assert.deepEqual(interrupts, ["session-s2"]);
    Object.assign(second.api.stories.get("s2")!, { agentStatus: "Paused" });
    await second.stories.refresh("a");
    assert.equal(
      (await second.orchestrator.changed(epicId)).pause?.phase,
      "paused",
    );
    // Resumed: both, since both were the pause's.
    second.epics.get(epicId)!.status = "active";
    await second.orchestrator.changed(epicId);
    const resumed = second.fake.calls
      .filter((item) => item.method === "send")
      .map((item) => (item.input as { session: string }).session)
      .sort();
    assert.deepEqual(resumed, ["session-s1", "session-s2"]);
    assert.equal(await keptPause(second.stateFile), undefined);
  });

  it("has the pause on disk before it stops anything, so a quit part way loses none of it", async () => {
    const { epics, orchestrator, stateFile } = await desk({
      rows: [running("s1"), running("s2", { storyNumber: 2 })],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: { "session-s1": runningTurn, "session-s2": runningTurn },
      hangInterrupt: ["session-s1"],
    });
    epics.get(epicId)!.status = "paused";
    // The first agent's stop never answers: Blame quits in the middle.
    void orchestrator.changed(epicId).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pause = await keptPause(stateFile);
    assert.equal(pause?.phase, "pausing");
    assert.deepEqual(pause?.stories.sort(), ["s1", "s2"]);
  });

  it("leaves to the person a story they acted on during the pause", async () => {
    const { orchestrator, epics, api, fake, stories } = await desk({
      rows: [running("s1"), running("s2", { storyNumber: 2 })],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: { "session-s1": runningTurn, "session-s2": runningTurn },
    });
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    for (const id of ["s1", "s2"])
      Object.assign(api.stories.get(id)!, { agentStatus: "Paused" });
    await stories.refresh("a");
    // The person pauses s2 again from its drawer: it is theirs now.
    orchestrator.touched("s2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    const resumed = fake.calls
      .filter((item) => item.method === "send")
      .map((item) => (item.input as { session: string }).session);
    assert.deepEqual(resumed, ["session-s1"]);
  });

  it("cuts only the conversation's turn running when the pause came, never the person's later one", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
    ]);
    const { orchestrator, epics, interrupted, stateFile } = await desk({
      records,
    });
    epics.get(epicId)!.status = "paused";
    assert.equal((await orchestrator.changed(epicId)).pause?.phase, "pausing");
    assert.deepEqual(interrupted, [session]);
    assert.equal((await keptPause(stateFile))?.stories.length, 0);
    // Its turn ends; the person talks to it while the epic is paused.
    records.push(
      ...conversation(
        [
          {
            type: "turn_ended",
            turn: "t1",
            outcome: { status: "interrupted" },
          },
          {
            type: "user_message",
            turn: "t2",
            input: text("How is it going?"),
            delivery: "turn",
          },
          requestStarted("t2"),
        ],
        records.length,
      ),
    );
    for (let look = 0; look < 3; look += 1)
      assert.equal((await orchestrator.changed(epicId)).pause?.phase, "paused");
    assert.deepEqual(interrupted, [session], "the person's turn runs");
  });

  it("wakes the turn the pause cut on the resume, once, and ends the pause", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
    ]);
    const { orchestrator, epics, written, stateFile } = await desk({
      records,
    });
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    records.push(
      ...conversation(
        [
          {
            type: "turn_ended",
            turn: "t1",
            outcome: { status: "interrupted" },
          },
        ],
        records.length,
      ),
    );
    assert.equal((await orchestrator.changed(epicId)).pause?.phase, "paused");
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    assert.equal(written.length, 1);
    assert.equal(await keptPause(stateFile), undefined);
    // The wake's turn runs: nothing more is owed.
    records.push(
      ...conversation(
        [
          {
            type: "user_message",
            turn: "t2",
            input: text("wake"),
            delivery: "turn",
          },
          requestStarted("t2"),
        ],
        records.length,
      ),
    );
    await orchestrator.changed(epicId);
    assert.equal(written.length, 1);
    assert.match(JSON.stringify(written[0]), /\\"reason\\":\\"resumed\\"/);
    assert.match(JSON.stringify(written[0]), /\\"cut\\":\\"pause\\"/);
    assert.match(JSON.stringify(written[0]), /The person paused the epic/);
    assert.equal(await keptPause(stateFile), undefined);
  });

  it("ends the pause on the resume when the person stopped a turn of theirs after the cut", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
    ]);
    const { orchestrator, epics, written, stateFile } = await desk({
      records,
    });
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    // The cut turn ends; the person talks to it, then stops that turn.
    records.push(
      ...conversation(
        [
          {
            type: "turn_ended",
            turn: "t1",
            outcome: { status: "interrupted" },
          },
          {
            type: "user_message",
            turn: "t2",
            input: text("Wait."),
            delivery: "turn",
          },
          requestStarted("t2"),
        ],
        records.length,
      ),
    );
    await orchestrator.changed(epicId);
    await orchestrator.interrupted(session);
    records.push(
      ...conversation(
        [
          {
            type: "turn_ended",
            turn: "t2",
            outcome: { status: "interrupted" },
          },
        ],
        records.length,
      ),
    );
    epics.get(epicId)!.status = "active";
    const resumed = await orchestrator.changed(epicId);
    assert.equal(resumed.conversation, "stopped");
    assert.equal(await keptPause(stateFile), undefined);
    assert.deepEqual(written, [], "the person's stop is not undone");
  });

  it("lets a message that waited through a quit go on while the epic is paused", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
      // Sent while it worked, then Blame quit.
      {
        type: "user_message",
        turn: "t2",
        input: text("Where are we?"),
        delivery: "turn",
      },
      { type: "turn_ended", turn: "t1", outcome: { status: "interrupted" } },
    ]);
    const { orchestrator, epics, fake, interrupted } = await desk({ records });
    epics.get(epicId)!.status = "paused";
    assert.equal((await orchestrator.changed(epicId)).pause?.phase, "paused");
    assert.deepEqual(interrupted, []);
    assert.deepEqual(
      fake.calls
        .filter((item) => item.method === "promote")
        .map((item) => item.input),
      [{ session, turn: "t2" }],
    );
  });

  it("lets only the person's queued message go on while paused, and tells the queued wake's stories after the resume", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
      // Queued behind it when Blame quit: a wake, then the person.
      {
        type: "user_message",
        turn: "w2",
        input: queuedWake,
        delivery: "turn",
      },
      {
        type: "user_message",
        turn: "t3",
        input: text("Where are we?"),
        delivery: "turn",
      },
      { type: "turn_ended", turn: "t1", outcome: { status: "interrupted" } },
    ]);
    const { orchestrator, epics, fake, written } = await desk({
      records,
      epic: { status: "paused" },
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": endedA1 },
    });
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    const queueCalls = () =>
      fake.calls
        .filter(
          (item) => item.method === "withdraw" || item.method === "promote",
        )
        .map((item) => [item.method, (item.input as { turn: string }).turn]);
    // The wake is taken back before the person's message goes on (each
    // look does so while the engine's log has not moved yet).
    assert.deepEqual(queueCalls().slice(0, 2), [
      ["withdraw", "w2"],
      ["promote", "t3"],
    ]);
    assert.ok(
      queueCalls().every(
        ([method, turn]) =>
          (method === "withdraw" && turn === "w2") ||
          (method === "promote" && turn === "t3"),
      ),
    );
    assert.deepEqual(written, [], "no wake while paused");
    // The engine takes the wake back; the person's turn runs and ends.
    records.push(
      ...conversation(
        [
          { type: "turn_ended", turn: "w2", outcome: { status: "withdrawn" } },
          requestStarted("t3"),
          { type: "turn_ended", turn: "t3", outcome: { status: "completed" } },
        ],
        records.length,
      ),
    );
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    assert.equal(written.length, 1, "what the wake carried is told once");
    assert.match(JSON.stringify(written[0]), /a1/);
  });

  it("keeps a queue of wakes only for the resume, then sends it on", async () => {
    const records = conversation([
      {
        type: "user_message",
        turn: "t1",
        input: text("Go."),
        delivery: "turn",
      },
      requestStarted("t1"),
      {
        type: "user_message",
        turn: "w2",
        input: queuedWake,
        delivery: "turn",
      },
      { type: "turn_ended", turn: "t1", outcome: { status: "interrupted" } },
    ]);
    const { orchestrator, epics, fake, written } = await desk({
      records,
      epic: { status: "paused" },
      rows: [inReview("s1")],
      owned: { s1: "session-s1" },
      statuses: { "session-s1": endedA1 },
    });
    const promoted = () =>
      fake.calls
        .filter(
          (item) => item.method === "promote" || item.method === "withdraw",
        )
        .map((item) => (item.input as { turn: string }).turn);
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    assert.deepEqual(promoted(), []);
    epics.get(epicId)!.status = "active";
    await orchestrator.changed(epicId);
    assert.deepEqual(promoted(), ["w2"]);
    assert.deepEqual(written, [], "the queued wake goes on: no second one");
  });

  it("refuses what would move a paused epic, and reads, talks and sleeps", async () => {
    const { api, epics, report, run } = await desk({
      rows: [
        inReview("s1"),
        row("s2", "a", { epicId, status: "backlog", storyNumber: 2 }),
      ],
      statuses: { "session-s1": verified },
    });
    epics.get(epicId)!.status = "paused";
    await assert.rejects(
      run("approve_story", { reason: "Verified.", storyId: "s1" }),
      /^Error: US-001 is not merged: the epic is paused\. Until the person resumes it/,
    );
    await assert.rejects(
      run("message_story", {
        storyId: "s1",
        kind: "answer",
        message: "Go on.",
      }),
      /US-001 gets no message: the epic is paused\./,
    );
    await assert.rejects(
      run("update_story", { reason: "Now.", storyId: "s2", queue: true }),
      /US-002 is not queued: the epic is paused\./,
    );
    await assert.rejects(
      run("reject_story", { reason: "Not needed.", storyId: "s1" }),
      /US-001 is not rejected: the epic is paused\./,
    );
    assert.equal(api.stories.get("s1")!.status, "in-review");
    await assert.rejects(
      run("create_stories", {
        reason: "More.",
        stories: [{ key: "x", title: "X", brief: "Do x.", intent: "balanced" }],
      }),
      /No story is created: the epic is paused\. Create them held \(hold\)/,
    );
    assert.equal(
      ((await report("epic_board", {})).stories as unknown[]).length,
      2,
    );
    assert.match(
      String(await run("end_turn", { action: "wait", reason: "Paused." })),
      /^Waiting: the epic is paused\. You will be woken once it is resumed/,
    );
  });

  it("never resumes a story twice: a second resume while the first is in flight is left", async () => {
    const { stories, starts, sends } = await desk({
      rows: [running("s1", { agentStatus: "Paused" })],
      owned: { s1: "session-s1" },
    });
    let release = () => {};
    starts.send = new Promise((resolve) => (release = resolve));
    // The person's resume is in flight when the epic's comes.
    const person = stories.resume("s1");
    await settle(() => sends.length === 1, "the person's resume");
    const epic = stories.resume("s1", undefined, () => true);
    release();
    await Promise.all([person, epic]);
    assert.deepEqual(sends, ["session-s1"]);
  });

  it("hears a person's act before it runs, so the epic's resume leaves that story", async () => {
    const { orchestrator, epics, api, stories } = await desk({
      rows: [running("s1"), running("s2", { storyNumber: 2 })],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: { "session-s1": runningTurn, "session-s2": runningTurn },
    });
    epics.get(epicId)!.status = "paused";
    await orchestrator.changed(epicId);
    for (const id of ["s1", "s2"])
      Object.assign(api.stories.get(id)!, { agentStatus: "Paused" });
    await stories.refresh("a");
    const kept = () =>
      (orchestrator as unknown as { state: OrchestratorState }).state.peek(
        epicId,
      )?.pause?.stories ?? [];
    const pauseNamed: boolean[] = [];
    const resume = stories.resume.bind(stories);
    stories.resume = (storyId, turn, still) => {
      pauseNamed.push(kept().includes(storyId));
      return resume(storyId, turn, still);
    };
    const handlers = storyHandlers(
      () => stories,
      (storyId) => orchestrator.touched(storyId),
    );
    await handlers.storyResume({ storyId: "s1" });
    assert.deepEqual(pauseNamed, [false]);
    assert.deepEqual(kept(), ["s2"]);
  });

  it("says a pause did not take when the engine cannot be reached", async () => {
    const { orchestrator, epics } = await desk({ noEngine: true });
    epics.get(epicId)!.status = "paused";
    await assert.rejects(
      orchestrator.changed(epicId),
      /Blame could not act on the epic's change: The agent engine did not answer/,
    );
  });

  it("looks again only at the epic's own stories, never another story's start", async () => {
    const { orchestrator, stories, starts } = await desk({
      rows: [
        row("plain", "a", { status: "ready", runMode: "local-container" }),
      ],
      failStart: true,
    });
    await settle(() => starts.count === 1, "the first start");
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some(
            (wait) => wait.storyId === "plain" && wait.reason.kind === "error",
          ),
      "the start to fail",
    );
    for (let look = 0; look < 5; look += 1)
      await orchestrator.epicState(epicId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(starts.count, 1, "its 30 s pause before the next start holds");
  });

  it("keeps counting a failing start through the waits between attempts", async () => {
    const { orchestrator, stories } = await desk({
      rows: [
        row("s1", "a", { epicId, status: "ready", runMode: "local-container" }),
      ],
      failStart: true,
      stuckStartMs: 200,
    });
    const phase = (runtimePhase: string) =>
      sync(stories, [{ id: "a", path: "/a" }], "window", {
        ...preferences,
        runMode: "local-container",
        runtimePhase,
      });
    const waits = (kind: string) =>
      stories.queueState().waiting.some((wait) => wait.reason.kind === kind);
    await settle(() => waits("error"), "the first failure");
    await orchestrator.epicState(epicId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Between attempts it waits for the runtime, then fails again.
    await phase("starting");
    await settle(() => waits("runtime"), "a wait for the runtime");
    await orchestrator.epicState(epicId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await phase("ready");
    await settle(() => waits("error"), "the second failure");
    assert.equal(
      (await orchestrator.epicState(epicId)).blocked?.length,
      1,
      "its clock ran from the first failure",
    );
  });

  it("calls a start that keeps failing blocked", async () => {
    const { orchestrator, stories } = await desk({
      rows: [
        row("s1", "a", { epicId, status: "ready", runMode: "local-container" }),
      ],
      failStart: true,
      stuckStartMs: 0,
    });
    await settle(
      () =>
        stories
          .queueState()
          .waiting.some((wait) => wait.reason.kind === "error"),
      "the start to fail",
    );
    assert.equal((await orchestrator.epicState(epicId)).blocked?.length, 1);
    const story = stories.epicStories(epicId)[0]!;
    assert.equal(orchestrator.blocked(story), true);
  });

  it("never counts a blocked story's start attempt as work, so wait is refused through it", async () => {
    const { orchestrator, report, run, stories, starts } = await desk({
      rows: [
        row("s1", "a", { epicId, status: "ready", runMode: "local-container" }),
      ],
      failStart: true,
      stuckStartMs: 0,
    });
    const failed = () =>
      stories.queueState().waiting.some((wait) => wait.reason.kind === "error");
    await settle(failed, "the start to fail");
    assert.equal((await orchestrator.epicState(epicId)).blocked?.length, 1);
    let release = () => {};
    starts.gate = new Promise((resolve) => (release = resolve));
    try {
      stories.retry(["s1"]);
      await settle(
        () => stories.queueState().starting.includes("s1"),
        "another attempt",
      );
      await assert.rejects(
        run("end_turn", { action: "wait" }),
        /The orchestrator cannot sleep: nothing of the epic is working/,
      );
      const board = await report("epic_board", {});
      assert.equal((board.counts as { working: number }).working, 0);
      assert.equal(
        (board.stories as Array<{ status: string }>)[0]!.status,
        "ready",
      );
    } finally {
      starts.gate = undefined;
      release();
    }
  });

  it("tells an idle epic once for each wait it ended with", () => {
    const stories = [{ id: "s1", status: "ready" as const, agentStatus: null }];
    const failing = [
      { storyId: "s1", reason: "its start keeps failing: gone" },
    ];
    const signature = idleSignature(stories, failing);
    assert.equal(idleTold("t1", signature), idleTold("t1", signature));
    // A wait accepted after the idle wake (something worked then) is
    // answered again once nothing does, whatever the stories look like.
    assert.notEqual(idleTold("t2", signature), idleTold("t1", signature));
  });

  it("tells a blocked story once: the same states and reasons are not news", () => {
    const stories = [{ id: "s1", status: "ready" as const, agentStatus: null }];
    const failing = [
      { storyId: "s1", reason: "its start keeps failing: gone" },
    ];
    const told = idleSignature(stories, failing);
    // It flickers to waiting for the runtime, then fails the same way.
    assert.notEqual(idleSignature(stories, []), told);
    assert.equal(idleSignature(stories, failing), told);
    // Another error, a start, or the person's act is news.
    assert.notEqual(
      idleSignature(stories, [
        { storyId: "s1", reason: "its start keeps failing: other" },
      ]),
      told,
    );
    assert.notEqual(
      idleSignature(
        [{ ...stories[0]!, status: "in-progress" as const }],
        failing,
      ),
      told,
    );
  });

  it("makes a lost branch again while nothing was merged into it, and holds the epic once something was", async () => {
    const fresh = await desk();
    fresh.branches.delete(epicBranch);
    await fresh.orchestrator.epicState(epicId);
    assert.ok(fresh.branches.has(epicBranch), "made again from the target");
    const merged = await desk({
      rows: [
        row("s1", "a", { epicId, status: "done" }),
        row("s2", "a", { epicId, status: "ready", storyNumber: 2 }),
      ],
    });
    merged.branches.delete(epicBranch);
    const state = await merged.orchestrator.epicState(epicId);
    assert.ok(
      !merged.branches.has(epicBranch),
      "never made again over merged work",
    );
    assert.match(
      state.error ?? "",
      /branch epic\/checkout-flow is gone, and stories were already merged into it/,
    );
    assert.deepEqual(
      merged.orchestrator.holds({
        ...row("s9", "a", { epicId }),
        status: "ready",
      } as never),
      { kind: "epic", epicId, hold: "branch" },
    );
    await assert.rejects(
      merged.run("create_stories", { reason: "r", stories: [newStory()] }),
      /Nothing starts: the epic's branch epic\/checkout-flow is gone/,
    );
    await assert.rejects(
      merged.run("update_story", { reason: "r", storyId: "s2", queue: true }),
      /Nothing starts: the epic's branch epic\/checkout-flow is gone/,
    );
    // Restored by the person: the epic goes on.
    merged.branches.add(epicBranch);
    await merged.orchestrator.epicState(epicId);
    assert.equal(
      merged.orchestrator.holds({
        ...row("s9", "a", { epicId }),
        status: "ready",
      } as never),
      undefined,
    );
  });

  it("holds, and writes nothing over, a kept file it cannot read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orchestrator-unreadable-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    // A folder where the file should be: reading it fails, not as missing.
    const stateFile = join(directory, "epics.json");
    await mkdir(stateFile);
    const { orchestrator } = await desk({ prepare: false, stateFile });
    const story = { ...row("s9", "a", { epicId }), status: "ready" } as never;
    assert.deepEqual(orchestrator.holds(story), {
      kind: "epic",
      epicId,
      hold: "unknown",
    });
    await assert.rejects(orchestrator.epicState(epicId), /cannot be read/);
    assert.ok(
      (await stat(stateFile)).isDirectory(),
      "nothing was written over it",
    );
  });

  it("drops what is kept of a story only once it is merged or rejected", async () => {
    const { report, orchestrator, api, stories, stateFile } = await desk({
      rows: [inReview("s1"), inReview("s2", { storyNumber: 2 })],
      owned: { s1: "session-s1", s2: "session-s2" },
      statuses: {
        "session-s1": {
          ...verifiedFields,
          endedTurns: [{ turn: "t1", outcome: { status: "completed" } }],
        } as never,
        "session-s2": {
          ...verifiedFields,
          endedTurns: [{ turn: "t2", outcome: { status: "completed" } }],
        } as never,
      },
    });
    await report("epic_board", {});
    const heard = async () =>
      (
        JSON.parse(await readFile(stateFile, "utf8")) as {
          epics: Record<string, { heard?: Record<string, string> }>;
        }
      ).epics[epicId]?.heard ?? {};
    assert.deepEqual(Object.values(await heard()).sort(), ["s1", "s2"]);
    Object.assign(api.stories.get("s1")!, { status: "done" });
    await stories.refresh("a");
    await orchestrator.epicState(epicId);
    assert.deepEqual(Object.values(await heard()), ["s2"]);
  });
});
