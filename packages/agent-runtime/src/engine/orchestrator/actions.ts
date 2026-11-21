// What each orchestrator tool does, and what the host refuses whatever the
// prompt says (docs/orchestrator.md, "Tools"): approving a story the
// harness did not verify, a fourth request for changes, sleeping with
// nothing at work, finishing with stories open, and starting or messaging
// once the budget is spent. A refusal is the call's error, saying what to
// do instead.

import {
  escalateModel,
  resolveModelIntent,
  type ModelIntent,
  type ModelPool,
} from "../model-intent.js";
import type {
  Epic,
  EpicSpend,
  OrchestratorToolInputs,
  StoryRequestedModel,
  StoryRunMode,
  StoryWaitReason,
} from "../protocol.js";
import { storyApi } from "../stories/api.js";
import { initializationDecision } from "../stories/queue.js";
import type { StoryService } from "../stories/service.js";
import { storyDisplayId, type HostStory } from "../stories/story.js";
import { epicCounts, epicHasWork, outcomeFacts, storyWorks } from "./board.js";
import { ensureBranch, type GitRun } from "./branch.js";
import { waitWords } from "./gate.js";
import type { EpicReading } from "./reading.js";
import type { Orchestrator } from "./service.js";
import type { OrchestratorState } from "./state.js";

/** What the tools of one epic's conversation reach. */
export type EpicDesk = {
  epicId: string;
  session: string;
  orchestrator: Orchestrator;
  stories: StoryService;
  state: OrchestratorState;
  git?: GitRun;
  starting(): ReadonlySet<string>;
  /** The queue's gate holds it (its epic paused or spent, or run elsewhere). */
  holds(story: HostStory): StoryWaitReason | undefined;
  /** It will not start by itself: held, or its wait needs the person. */
  blocked(story: HostStory): boolean;
};

type Inputs = OrchestratorToolInputs;

/** Requests for changes a story may get before it is rejected instead. */
export const maxChangeRequests = 3;
/** Messages of any kind a story may get from the orchestrator. */
export const maxMessages = 6;

// ------------------------------------------------------------------ board

export async function epicBoard(desk: EpicDesk) {
  const look = await fresh(desk);
  const stories = look.epicStories();
  const starting = desk.starting();
  const waiting = new Map(
    desk.stories.queueState().waiting.map((wait) => [wait.storyId, wait]),
  );
  const spend = await look.spend();
  const entry = await desk.state.get(desk.epicId);
  const shown: Array<{ session: string; turn: string }> = [];
  const rows = await Promise.all(
    stories.map(async (story) => {
      const status = await look.status(story.id);
      const last = status?.endedTurns?.at(-1);
      if (status && last)
        shown.push({ session: status.session, turn: last.turn });
      const wait = waiting.get(story.id)?.reason;
      return {
        id: story.id,
        number: storyDisplayId(story),
        title: story.title,
        status: storyWorks(story, starting) ? "working" : story.status,
        ...(story.agentStatus === "Paused" ? { paused: true } : {}),
        ...(story.startsAfter?.length
          ? { startsAfter: story.startsAfter }
          : {}),
        ...(wait && story.status === "ready"
          ? {
              waitsFor: waitWords(wait),
              ...(desk.blocked(story) ? { needsPerson: true } : {}),
            }
          : {}),
        ...(story.modelIntent ? { intent: story.modelIntent } : {}),
        model: modelName(story),
        turns: status?.turns ?? turnCount(story),
        ...(status?.lastOutcome
          ? {
              lastTurn: {
                outcome: status.lastOutcome.status,
                ...outcomeFacts(status.lastOutcome),
              },
            }
          : {}),
        costMicroUsd:
          spend.stories.find((item) => item.storyId === story.id)?.microUsd ??
          0,
        changesRequested: entry?.changes[story.id] ?? 0,
      };
    }),
  );
  // The last ended turn of each story the answer shows: no wake repeats it.
  await look.markHeard(shown);
  return {
    epic: {
      title: look.epic.title,
      status: look.epic.status,
      branch: look.epic.branch,
      targetBranch: look.epic.targetBranch,
    },
    stories: rows,
    counts: epicCounts(stories, starting),
    spend: spendFacts(spend),
  };
}

// ---------------------------------------------------------------- create

export async function createStories(
  desk: EpicDesk,
  input: Inputs["create_stories"],
) {
  const look = await fresh(desk);
  const epic = look.epic;
  assertBudget(await look.spend());
  if (!epic.branch || !epic.targetBranch)
    throw new Error(
      "The epic has no branch yet: its conversation was not created here.",
    );
  const batch = input.stories ?? [];
  if (!batch.length) throw new Error("Give at least one story.");
  const known = new Map(look.epicStories().map((story) => [story.id, story]));
  const keys = new Set<string>();
  for (const story of batch) {
    if (!story.key?.trim()) throw new Error("Every story needs a key.");
    if (keys.has(story.key))
      throw new Error(`Two stories use the key ${story.key}.`);
    keys.add(story.key);
    if (!story.title?.trim() || !story.brief?.trim())
      throw new Error(`Story ${story.key} needs a title and a brief.`);
  }
  for (const story of batch)
    for (const dependency of story.startsAfter ?? []) {
      if (keys.has(dependency)) continue;
      const other = known.get(dependency);
      if (!other)
        throw new Error(
          `Story ${story.key} starts after ${dependency}, which is neither a key of this call nor a story of the epic.`,
        );
      if (other.status === "discarded")
        throw new Error(
          `Story ${story.key} starts after ${storyDisplayId(other)}, which was rejected: it would never start.`,
        );
    }
  const order = dependencyOrder(batch);
  const runMode = batch.some((story) => !story.hold)
    ? await isolatedRunMode(desk, epic)
    : await isolatedRunMode(desk, epic).catch(() => undefined);
  await epicBranchReady(desk, epic);
  const pool = await modelPool(desk, epic);
  const created = new Map<string, HostStory>();
  const answers: Array<Record<string, unknown>> = [];
  for (const story of order) {
    const choice = chooseModel(desk, pool, story.intent);
    const record = await desk.stories.create({
      projectId: epic.projectId,
      title: story.title.trim(),
      summary: story.brief.trim(),
      status: story.hold ? "backlog" : "ready",
      startsAfter: (story.startsAfter ?? []).map(
        (dependency) => created.get(dependency)?.id ?? dependency,
      ),
      requestedModel: choice.requested,
      modelIntent: story.intent,
      epicId: epic.id,
      targetBranch: epic.branch,
      ...(runMode ? { runMode } : {}),
    });
    created.set(story.key, record);
    answers.push({
      key: story.key,
      id: record.id,
      number: storyDisplayId(record),
      model: `${choice.requested.providerId}/${choice.requested.modelId}`,
      intent: story.intent,
      ...(choice.fallback
        ? { fallback: "nothing ranked: the account's agent model" }
        : {}),
      status: story.hold ? "held" : "queued",
    });
  }
  return { created: answers };
}

// ---------------------------------------------------------------- update

export async function updateStory(
  desk: EpicDesk,
  input: Inputs["update_story"],
) {
  const look = await fresh(desk);
  const story = epicStory(look, input.storyId);
  if (story.status !== "backlog" && story.status !== "ready")
    throw new Error(
      `${storyDisplayId(story)} has started: talk to its agent with message_story, or reject it.`,
    );
  const queue = input.queue === true && story.status === "backlog";
  if (queue) assertBudget(await look.spend());
  const known = new Set(look.epicStories().map(({ id }) => id));
  for (const dependency of input.startsAfter ?? [])
    if (!known.has(dependency) || dependency === story.id)
      throw new Error(`${dependency} is not another story of the epic.`);
  const update: Parameters<StoryService["edit"]>[1] = {};
  if (input.title?.trim()) update.title = input.title.trim();
  if (input.brief?.trim()) update.summary = input.brief.trim();
  if (input.startsAfter) update.startsAfter = input.startsAfter;
  if (input.intent) {
    const choice = chooseModel(
      desk,
      await modelPool(desk, look.epic),
      input.intent,
    );
    update.modelIntent = input.intent;
    update.requestedModel = choice.requested;
  }
  if (queue) {
    update.runMode = await isolatedRunMode(desk, look.epic);
    await epicBranchReady(desk, look.epic);
  }
  let edited = story;
  if (Object.keys(update).length)
    edited = await desk.stories.edit(story.id, update);
  if (queue) edited = await desk.stories.enqueue(story.id);
  return {
    id: edited.id,
    number: storyDisplayId(edited),
    status:
      edited.status === "ready"
        ? "queued"
        : edited.status === "backlog"
          ? "held"
          : edited.status,
    model: modelName(edited),
  };
}

// ---------------------------------------------------------------- report

export async function storyReport(
  desk: EpicDesk,
  input: Inputs["story_report"],
) {
  const look = await fresh(desk);
  const story = epicStory(look, input.storyId);
  const status = await look.status(story.id);
  const spend = await look.spend();
  const entry = await desk.state.get(desk.epicId);
  const last = status?.endedTurns?.at(-1);
  if (status && last)
    await look.markHeard([{ session: status.session, turn: last.turn }]);
  return {
    id: story.id,
    number: storyDisplayId(story),
    title: story.title,
    status: story.status,
    ...(story.agentStatus ? { agent: story.agentStatus } : {}),
    ...(status?.lastOutcome
      ? {
          outcome: status.lastOutcome.status,
          ...outcomeFacts(status.lastOutcome),
        }
      : { outcome: null }),
    ...(story.agentLastError ? { lastError: story.agentLastError } : {}),
    reply: status?.lastReply ?? null,
    files: await changedFiles(desk, story),
    turns: status?.turns ?? turnCount(story),
    model: modelName(story),
    costMicroUsd:
      spend.stories.find((item) => item.storyId === story.id)?.microUsd ?? 0,
    changesRequested: entry?.changes[story.id] ?? 0,
    ...(status === undefined &&
    story.engineSessionId &&
    story.status !== "done" &&
    story.status !== "discarded"
      ? {
          note: "Its agent's records are not on this computer: the outcome is unknown here.",
        }
      : {}),
  };
}

// --------------------------------------------------------------- message

export async function messageStory(
  desk: EpicDesk,
  input: Inputs["message_story"],
) {
  const look = await fresh(desk);
  const story = epicStory(look, input.storyId);
  if (!input.message?.trim()) throw new Error("The message is empty.");
  if (input.kind !== "answer" && input.kind !== "changes")
    throw new Error("kind is answer or changes.");
  assertBudget(await look.spend());
  const entry = await desk.state.get(desk.epicId);
  const sent = entry?.messages?.[story.id] ?? 0;
  if (sent >= maxMessages)
    throw new Error(
      `${storyDisplayId(story)} already had ${sent} messages from you: reject it and write a better story, or ask the person.`,
    );
  // Whatever its label, a message to a story whose turn ended (in review)
  // asks it to change its work.
  const changes = input.kind === "changes" || story.status === "in-review";
  const requested = entry?.changes[story.id] ?? 0;
  if (changes && requested >= maxChangeRequests)
    throw new Error(
      `${storyDisplayId(story)} already had ${requested} requests for changes (a message after its turn ended is one): reject it and write a better story, or ask the person.`,
    );
  let model: ReturnType<typeof escalateModel> = null;
  if (input.escalate) {
    const current = story.agentModels?.at(-1) ?? story.requestedModel;
    if (!current)
      throw new Error(
        `${storyDisplayId(story)} has no model to escalate from.`,
      );
    model = escalateModel({ ...(await modelPool(desk, look.epic)), current });
    if (!model)
      throw new Error(
        `${storyDisplayId(story)} already runs on the smartest model the epic allows: send the message without escalate, or reject it.`,
      );
  }
  // Counted before it goes: a quit after the send never forgets one.
  await countMessage(desk, story.id, changes, 1);
  try {
    await desk.stories.send(story.id, {
      message: { text: input.message.trim() },
      ...(model ? { turn: { model: model.model } } : {}),
    });
  } catch (error) {
    await countMessage(desk, story.id, changes, -1);
    throw error;
  }
  return {
    sent: true,
    number: storyDisplayId(story),
    ...(model
      ? { model: `${model.model.providerId}/${model.model.modelId}` }
      : {}),
    ...(changes
      ? {
          changesRequested: requested + 1,
          left: maxChangeRequests - requested - 1,
        }
      : {}),
    messagesLeft: maxMessages - sent - 1,
  };
}

// --------------------------------------------------------------- endings

export async function approveStory(
  desk: EpicDesk,
  input: Inputs["approve_story"],
) {
  const look = await fresh(desk);
  const story = epicStory(look, input.storyId);
  if (story.status !== "in-review")
    throw new Error(
      `${storyDisplayId(story)} is not in review: only a story in review can be approved.`,
    );
  if (story.agentStatus === "Running")
    throw new Error(
      `${storyDisplayId(story)}'s agent is working: wait for its turn to end.`,
    );
  const status = await look.status(story.id);
  if (!status?.exists)
    throw new Error(
      `${storyDisplayId(story)}'s agent records are not on this computer: it cannot be judged here.`,
    );
  if (status.turnRunning ?? status.running)
    throw new Error(
      `${storyDisplayId(story)}'s agent is working: wait for its turn to end.`,
    );
  if (status.lastOutcome?.status !== "completed") {
    const facts = outcomeFacts(status.lastOutcome);
    throw new Error(
      `${storyDisplayId(story)}'s last turn did not end completed (${status.lastOutcome?.status ?? "no turn"}${facts.failingChecks ? `: ${facts.failingChecks.join(", ")} still fail` : ""}): the harness did not accept its finish_task. Ask for changes, or reject it.`,
    );
  }
  // The target branch only moves when the person approves the epic: a
  // story merges into the epic's branch as this host made it, or not at all.
  const entry = await desk.state.get(desk.epicId);
  const branch = entry?.branch;
  if (
    !branch ||
    look.epic.branch !== branch ||
    branch === look.epic.targetBranch ||
    story.targetBranch !== branch
  )
    throw new Error(
      `${storyDisplayId(story)} would merge into ${story.targetBranch ?? "the project folder's branch"}, not the epic's branch${branch ? ` ${branch}` : ""}: it is not merged. Ask the person.`,
    );
  if (
    (story.workspaceMode ?? "direct") === "direct" ||
    story.runMode === "direct"
  )
    throw new Error(
      `${storyDisplayId(story)} ran Direct, in the project folder: it is not merged into the epic. Reject it and write it again.`,
    );
  const model = desk.orchestrator.orchestratorModel(
    look.epic,
    entry?.settings?.model,
  );
  if (!model)
    throw new Error("No model to write the merge's commit message with.");
  let outcome: Awaited<ReturnType<StoryService["approve"]>>;
  try {
    outcome = await desk.stories.approve(story.id, { model });
  } catch (error) {
    // Never resolved by the merge agent and merged unverified: the
    // story's own agent brings the epic's branch in and passes its checks.
    if (error instanceof Error && error.name === "StoryMergeConflictError")
      throw new Error(
        `${error.message} It is not merged. Ask for changes (message_story, kind changes): its agent merges ${branch} into its work (git merge ${branch}), resolves the conflicts, and passes its checks again.`,
      );
    throw error;
  }
  return {
    merged: true,
    number: storyDisplayId(story),
    into: outcome.merge.targetBranch,
    mergeCommit: outcome.merge.mergeCommit,
  };
}

export async function rejectStory(
  desk: EpicDesk,
  input: Inputs["reject_story"],
) {
  const look = await fresh(desk);
  const story = epicStory(look, input.storyId);
  if (story.status === "done")
    throw new Error(
      `${storyDisplayId(story)} is merged into the epic's branch: it stays.`,
    );
  await desk.stories.discard(
    story.id,
    input.reason?.trim() || "Rejected by the orchestrator.",
  );
  return { rejected: true, number: storyDisplayId(story) };
}

export async function endTurn(desk: EpicDesk, input: Inputs["end_turn"]) {
  const look = await fresh(desk);
  const stories = look.epicStories();
  const starting = desk.starting();
  if (input.action === "wait") {
    if (
      !epicHasWork(stories, starting, (story) =>
        desk.blocked(story as HostStory),
      )
    )
      throw new Error(
        "Nothing of the epic works or can start, so nothing would wake you: approve, ask for changes, queue or create stories, ask the person, or finish.",
      );
    return "Waiting: you will be woken when there is something to judge.";
  }
  if (input.action === "ask") {
    if (!input.question?.trim())
      throw new Error("ask needs the question for the person.");
    return "Asked: the person's answer comes as their next message.";
  }
  if (input.action === "finish") {
    const open = stories.filter(
      (story) => story.status !== "done" && story.status !== "discarded",
    );
    if (open.length)
      throw new Error(
        `Not every story is merged or rejected: ${open
          .map((story) => `${storyDisplayId(story)} (${story.status})`)
          .join(", ")}. Approve or reject each first.`,
      );
    if (!input.summary?.trim())
      throw new Error("finish needs the epic's summary.");
    return "Finished: the epic waits for the person's review.";
  }
  throw new Error("action is wait, ask or finish.");
}

// --------------------------------------------------------------- helpers

/** The epic and its stories as the API keeps them now. */
async function fresh(desk: EpicDesk): Promise<EpicReading> {
  const look = await desk.orchestrator.reading(desk.epicId);
  await desk.stories.refresh(look.epic.projectId);
  return look;
}

function epicStory(look: EpicReading, storyId: string): HostStory {
  const story = look
    .epicStories()
    .find((item) => item.id === storyId || storyDisplayId(item) === storyId);
  if (!story) throw new Error(`${storyId} is not a story of this epic.`);
  return story;
}

function assertBudget(spend: EpicSpend) {
  if (!spend.spent) return;
  throw new Error(
    `The epic's budget is spent (${usd(spend.totalMicroUsd)} of ${usd(spend.budgetMicroUsd ?? 0)}): nothing more starts. Approve or reject what is in review, ask the person to raise the budget, or finish.`,
  );
}

function spendFacts(spend: EpicSpend) {
  return {
    total: usd(spend.totalMicroUsd),
    orchestrator: usd(spend.orchestratorMicroUsd),
    stories: usd(spend.storiesMicroUsd),
    ...(spend.budgetMicroUsd !== undefined
      ? {
          budget: usd(spend.budgetMicroUsd),
          left: usd(spend.remainingMicroUsd ?? 0),
          spent: spend.spent,
        }
      : { budget: "none" }),
    ...(spend.unpricedRequests
      ? { unpricedRequests: spend.unpricedRequests }
      : {}),
  };
}

function usd(microUsd: number) {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

/** The batch with each story after the ones of the batch it starts after; a cycle is refused. */
function dependencyOrder<T extends { key: string; startsAfter?: string[] }>(
  batch: readonly T[],
) {
  const byKey = new Map(batch.map((story) => [story.key, story]));
  const ordered: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (story: T, path: string[]) => {
    const seen = state.get(story.key);
    if (seen === "done") return;
    if (seen === "visiting")
      throw new Error(
        `These stories start after each other in a cycle: ${[...path, story.key].join(" → ")}.`,
      );
    state.set(story.key, "visiting");
    for (const dependency of story.startsAfter ?? []) {
      const other = byKey.get(dependency);
      if (other) visit(other, [...path, story.key]);
    }
    state.set(story.key, "done");
    ordered.push(story);
  };
  for (const story of batch) visit(story, []);
  return ordered;
}

/**
 * How the epic's stories run: in a worktree of the epic's branch, never
 * Direct (in the project folder, on its current branch). A project whose
 * stories would run Direct (no working preview environment, or Direct as
 * the person's default) is refused: its stories would not land on the
 * epic's branch.
 */
async function isolatedRunMode(
  desk: EpicDesk,
  epic: Epic,
): Promise<StoryRunMode> {
  const preferences = desk.stories.preferences();
  const mode: StoryRunMode =
    preferences?.runMode && preferences.runMode !== "direct"
      ? preferences.runMode
      : "local-container";
  const { connection } = desk.stories.context();
  const snapshot = await storyApi(connection).initialization(epic.projectId);
  const decision = initializationDecision(
    snapshot.initialization,
    mode,
    Date.now(),
    preferences?.initializingProjects?.includes(epic.projectId) ?? false,
  );
  if (decision === "run-direct")
    throw new Error(
      "This project has no working preview environment, so its stories would run Direct in the project folder, on its current branch, not in worktrees of the epic's branch. Ask the person to set up the preview environment first.",
    );
  return mode;
}

async function modelPool(desk: EpicDesk, epic: Epic): Promise<ModelPool> {
  const recommendations = await desk.orchestrator.modelRanking();
  return {
    recommendations,
    ...(epic.settings.modelRange ? { range: epic.settings.modelRange } : {}),
    ...(epic.settings.providers?.length
      ? { providers: epic.settings.providers }
      : {}),
    ...(epic.settings.hiddenModels?.length
      ? { hidden: epic.settings.hiddenModels }
      : {}),
  };
}

function chooseModel(desk: EpicDesk, pool: ModelPool, intent: ModelIntent) {
  if (intent !== "cheaper" && intent !== "balanced" && intent !== "smarter")
    throw new Error("intent is cheaper, balanced or smarter.");
  const fallback = desk.orchestrator.fallbackModel();
  const resolution = resolveModelIntent({
    ...pool,
    intent,
    fallback: fallback ?? { providerId: "", modelId: "" },
  });
  if (resolution.fallback && !fallback?.providerId)
    throw new Error(
      "No model can run the stories: no ranked model is in the epic's range and the account has no agent model. Ask the person to connect a provider.",
    );
  // Nothing ranked: the account's model, only on a provider the epic allows.
  if (
    resolution.fallback &&
    (pool.providers?.length
      ? !pool.providers.includes(resolution.model.providerId)
      : false)
  )
    throw new Error(
      `No model of the providers the epic allows (${pool.providers!.join(", ")}) can be ranked, and the account's agent model is on ${resolution.model.providerId}. Ask the person to widen the providers or the range.`,
    );
  if (
    resolution.fallback &&
    pool.hidden?.some(
      (hidden) =>
        hidden.providerId === resolution.model.providerId &&
        hidden.modelId === resolution.model.modelId,
    )
  )
    throw new Error(
      "No visible model can be ranked in the epic's range, and the account's agent model is hidden. Ask the person.",
    );
  const model = resolution.model;
  const requested: StoryRequestedModel = {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.credentialLabel
      ? { credentialLabel: model.credentialLabel }
      : {}),
    ...(model.reasoning ? { reasoningEffort: model.reasoning } : {}),
  };
  return { requested, fallback: resolution.fallback };
}

/** The epic's branch exists (made again from its target if a quit cut its making). */
async function epicBranchReady(desk: EpicDesk, epic: Epic) {
  const branch = (await desk.state.get(desk.epicId))?.branch;
  if (!branch || !epic.targetBranch || epic.branch !== branch)
    throw new Error(
      "The epic's branch is not the one this computer made for it: nothing starts. Ask the person.",
    );
  await ensureBranch(
    requiredGit(desk),
    await workspaceRoot(desk),
    branch,
    epic.targetBranch,
  );
}

async function countMessage(
  desk: EpicDesk,
  storyId: string,
  changes: boolean,
  delta: number,
) {
  await desk.state.change(desk.epicId, (entry) => {
    const messages = (entry.messages ??= {});
    messages[storyId] = Math.max(0, (messages[storyId] ?? 0) + delta);
    if (changes)
      entry.changes[storyId] = Math.max(
        0,
        (entry.changes[storyId] ?? 0) + delta,
      );
  });
}

/** The files a story changed against its base: in its worktree, else between its base and merge. */
async function changedFiles(desk: EpicDesk, story: HostStory) {
  const git = desk.git;
  const base = story.baseCommit;
  if (!git || !base) return [];
  const diff = story.worktree
    ? { cwd: story.worktree, args: ["diff", "--name-status", base] }
    : story.mergeCommit
      ? {
          cwd: await workspaceRoot(desk),
          args: ["diff", "--name-status", base, story.mergeCommit],
        }
      : undefined;
  if (!diff) return [];
  const files: Array<{ path: string; change: string }> = [];
  try {
    for (const line of (await git(diff.cwd, diff.args)).split("\n")) {
      const [change, ...paths] = line.trim().split("\t");
      if (change && paths.length)
        files.push({ path: paths.at(-1)!, change: changeName(change) });
    }
    if (story.worktree)
      for (const path of (
        await git(story.worktree, [
          "ls-files",
          "--others",
          "--exclude-standard",
        ])
      ).split("\n"))
        if (path.trim()) files.push({ path: path.trim(), change: "added" });
  } catch {
    return files;
  }
  return files;
}

function changeName(code: string) {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

function modelName(story: HostStory) {
  const model = story.agentModels?.at(-1) ?? story.requestedModel;
  return model ? `${model.providerId}/${model.modelId}` : null;
}

function turnCount(story: HostStory) {
  return (story.agentModels ?? []).reduce(
    (total, model) => total + (model.turns ?? 0),
    0,
  );
}

async function workspaceRoot(desk: EpicDesk) {
  const root = (await desk.state.get(desk.epicId))?.settings?.workspace.root;
  if (!root) throw new Error("The epic's project folder is not known here.");
  return root;
}

function requiredGit(desk: EpicDesk) {
  if (!desk.git)
    throw new Error("Git is not available to the orchestrator here.");
  return desk.git;
}
