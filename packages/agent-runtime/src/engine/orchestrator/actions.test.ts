// The orchestrator's tools against the story service and an account in
// memory (no engine): each refusal the host enforces whatever the prompt
// says, the epic's branch, the stories it creates, the approvals asked
// before launching, the queue's gate, and what is kept across a relaunch
// or another account.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { parseEpic } from "./epics.js";
import { Orchestrator } from "./service.js";

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
  /** No conversation is created (a relaunch reads what is kept). */
  prepare?: boolean;
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
  if (setup.failStart)
    fake.host.desktop.createStoryWorktree = async () => {
      throw new Error("the epic's branch is gone");
    };
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
      if (method === "approveAndMerge" && setup.conflict) {
        const error = new Error(
          "Merging epic/checkout-flow into the story conflicts in src/cart.ts.",
        );
        error.name = "StoryMergeConflictError";
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
    readRecords: async ({ session: id }: { session: string }) => {
      throw new Error(`session ${id} does not exist`);
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
      client: async () => noRecords,
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
  };
}

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
const verified = { lastOutcome: { status: "completed" } } as never;
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
      /needs a key/,
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
      /has started/,
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
      /did not end completed \(contract_unmet: build still fail\)/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s3" }),
      /agent is working/,
    );
    // s4 is not this computer's: its records are not here.
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s4" }),
      /records are not on this computer/,
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
      /would merge into main, not the epic's branch/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s2" }),
      /would merge into the project folder's branch/,
    );
    await assert.rejects(
      run("approve_story", { reason: "r", storyId: "s3" }),
      /ran Direct/,
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
      /conflicts in src\/cart\.ts\. It is not merged\. Ask for changes .*git merge epic\/checkout-flow/,
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
      /already had 3 requests for changes/,
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
      /already had 6 messages from you/,
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
      /is merged into the epic's branch: it stays/,
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
      /Nothing of the epic works or can start/,
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
      /Nothing of the epic works or can start/,
    );
  });

  it("refuses to finish while a story is open, and ask or finish with nothing to say", async () => {
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
    await assert.rejects(
      closed.run("end_turn", { action: "finish", reason: "r" }),
      /finish needs the epic's summary/,
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
      /ask needs the question/,
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
