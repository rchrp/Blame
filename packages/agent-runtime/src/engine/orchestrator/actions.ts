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
  /** The epic's stories being started that will run (a blocked story's attempt is not work). */
  starting(stories: readonly HostStory[]): ReadonlySet<string>;
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
  const starting = desk.starting(stories);
  const waiting = new Map(
    desk.stories.queueState().waiting.map((wait) => [wait.storyId, wait]),
  );
  const spend = await look.spend();
  const entry = await desk.state.get(desk.epicId);
  const shown: Array<{ storyId: string; session: string; turn: string }> = [];
  const rows = await Promise.all(
    stories.map(async (story) => {
      const status = await look.status(story.id);
      const last = status?.endedTurns?.at(-1);
      if (status && last)
        shown.push({
          storyId: story.id,
          session: status.session,
          turn: last.turn,
        });
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
  if ((input.stories ?? []).some((story) => !story.hold))
    assertActive(
      look,
      "No story is created",
      `Create them held (hold) for later. ${pausedThen}`,
    );
  assertBudget(await look.spend());
  if (!epic.branch || !epic.targetBranch)
    throw refused(
      "The epic has no branch yet.",
      "Its conversation must be created on this computer first.",
    );
  const batch = input.stories ?? [];
  if (!batch.length) throw refused("No story was given.", "Give at least one.");
  const known = new Map(look.epicStories().map((story) => [story.id, story]));
  const keys = new Set<string>();
  for (const story of batch) {
    if (!story.key?.trim())
      throw refused("A story has no key.", "Give each story a key.");
    if (keys.has(story.key))
      throw refused(
        `Two stories use the key ${story.key}.`,
        "Give each its own key.",
      );
    keys.add(story.key);
    if (!story.title?.trim() || !story.brief?.trim())
      throw refused(
        `Story ${story.key} has no title or no brief.`,
        "Give both.",
      );
  }
  for (const story of batch)
    for (const dependency of story.startsAfter ?? []) {
      if (keys.has(dependency)) continue;
      const other = known.get(dependency);
      if (!other)
        throw refused(
          `Story ${story.key} starts after ${dependency}, which is neither a key of this call nor a story of the epic.`,
          "Name a key of this call or the id of one of the epic's stories.",
        );
      if (other.status === "discarded")
        throw refused(
          `Story ${story.key} starts after ${storyDisplayId(other)}, which was rejected, so it would never start.`,
          "Drop that dependency, or write that work again.",
        );
    }
  const order = dependencyOrder(batch);
  const runMode = batch.some((story) => !story.hold)
    ? await isolatedRunMode(desk, epic)
    : await isolatedRunMode(desk, epic).catch(() => undefined);
  await epicBranchReady(desk, look);
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
    throw refused(
      `${storyDisplayId(story)} has already started, so it no longer changes.`,
      "Talk to its agent with message_story, or reject it.",
    );
  const queue = input.queue === true && story.status === "backlog";
  if (input.queue) assertActive(look, `${storyDisplayId(story)} is not queued`);
  if (input.queue) assertBudget(await look.spend());
  const known = new Set(look.epicStories().map(({ id }) => id));
  for (const dependency of input.startsAfter ?? [])
    if (!known.has(dependency) || dependency === story.id)
      throw refused(
        `${dependency} is not another story of the epic.`,
        "Name the id of one of its stories.",
      );
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
  // A held story to queue, or a queued one waiting on a branch made again.
  if (input.queue) {
    update.runMode = await isolatedRunMode(desk, look.epic);
    await epicBranchReady(desk, look);
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
    await look.markHeard([
      { storyId: story.id, session: status.session, turn: last.turn },
    ]);
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
  if (!input.message?.trim())
    throw refused("The message is empty.", "Write what the agent should read.");
  if (input.kind !== "answer" && input.kind !== "changes")
    throw refused("The message has no kind.", "Use answer or changes.");
  assertActive(look, `${storyDisplayId(story)} gets no message`);
  assertBudget(await look.spend());
  const entry = await desk.state.get(desk.epicId);
  const sent = entry?.messages?.[story.id] ?? 0;
  if (sent >= maxMessages)
    throw refused(
      `${storyDisplayId(story)} has had its ${sent} messages from the orchestrator.`,
      "Reject it and write a better story, or ask the person.",
    );
  // Whatever its label, a message to a story whose turn ended (in review)
  // asks it to change its work.
  const changes = input.kind === "changes" || story.status === "in-review";
  const requested = entry?.changes[story.id] ?? 0;
  if (changes && requested >= maxChangeRequests)
    throw refused(
      `${storyDisplayId(story)} has had its ${requested} requests for changes (a message after its turn ended counts as one).`,
      "Reject it and write a better story, or ask the person.",
    );
  let model: ReturnType<typeof escalateModel> = null;
  if (input.escalate) {
    const current = story.agentModels?.at(-1) ?? story.requestedModel;
    if (!current)
      throw refused(
        `${storyDisplayId(story)} has no model to escalate from.`,
        "Send the message without escalate.",
      );
    model = escalateModel({ ...(await modelPool(desk, look.epic)), current });
    if (!model)
      throw refused(
        `${storyDisplayId(story)} already runs on the smartest model the epic allows.`,
        "Send the message without escalate, or reject it.",
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
  assertActive(look, `${storyDisplayId(story)} is not merged`);
  if (story.status !== "in-review")
    throw refused(
      `${storyDisplayId(story)} is not in review, so it cannot be approved.`,
      "Wait for its agent to finish, or message it.",
    );
  if (story.agentStatus === "Running")
    throw refused(
      `${storyDisplayId(story)}'s agent is still working, so it cannot be approved yet.`,
      "Wait for its turn to end.",
    );
  const status = await look.status(story.id);
  if (!status?.exists)
    throw refused(
      `${storyDisplayId(story)}'s agent ran on another computer, so its work cannot be judged here.`,
      "Ask the person.",
    );
  if (status.turnRunning ?? status.running)
    throw refused(
      `${storyDisplayId(story)}'s agent is still working, so it cannot be approved yet.`,
      "Wait for its turn to end.",
    );
  if (status.lastOutcome?.status !== "completed") {
    const facts = outcomeFacts(status.lastOutcome);
    throw refused(
      `${storyDisplayId(story)} is not merged: the harness did not verify its work (its last turn ended ${status.lastOutcome?.status ?? "with no turn"}${facts.failingChecks ? `: ${facts.failingChecks.join(", ")} still ${facts.failingChecks.length === 1 ? "fails" : "fail"}` : ""}).`,
      "Ask for changes, or reject it.",
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
    throw refused(
      `${storyDisplayId(story)} is not merged: it would merge into ${story.targetBranch ?? "the project folder's branch"}, not the epic's branch${branch ? ` ${branch}` : ""}.`,
      "Ask the person.",
    );
  if (
    (story.workspaceMode ?? "direct") === "direct" ||
    story.runMode === "direct"
  )
    throw refused(
      `${storyDisplayId(story)} is not merged: it ran Direct, in the project folder.`,
      "Reject it and write it again.",
    );
  const model = desk.orchestrator.orchestratorModel(
    look.epic,
    entry?.settings?.model,
  );
  if (!model)
    throw refused(
      `${storyDisplayId(story)} is not merged: there is no model to write its commit message with.`,
      "Ask the person to choose the orchestrator's model.",
    );
  let outcome: Awaited<ReturnType<StoryService["approve"]>>;
  try {
    outcome = await desk.stories.approve(story.id, { model });
  } catch (error) {
    // Never resolved by the merge agent and merged unverified: the
    // story's own agent brings the epic's branch in and passes its checks.
    if (error instanceof Error && error.name === "StoryMergeConflictError")
      throw refused(
        `${storyDisplayId(story)} is not merged: its changes conflict with what the epic's branch ${branch} already has${conflictWhere(error)}.${conflictLeft(error)}`,
        `Ask for changes (message_story, kind changes): its agent merges ${branch} into its work (git merge ${branch}), resolves the conflicts and passes its checks again.`,
        error,
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
    throw refused(
      `${storyDisplayId(story)} is already merged into the epic's branch, so it stays.`,
      "There is nothing to reject.",
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
  const starting = desk.starting(stories);
  if (input.action === "wait") {
    // The resume wakes it: what was paused goes on, or nothing works.
    if (look.epic.status === "paused")
      return "Waiting: the epic is paused. You will be woken once it is resumed and there is something to judge.";
    if (
      !epicHasWork(stories, starting, (story) =>
        desk.blocked(story as HostStory),
      )
    )
      throw refused(
        "The orchestrator cannot sleep: nothing of the epic is working or will start by itself, so nothing would wake it.",
        "Approve, ask for changes, queue or create stories, ask the person, or finish.",
      );
    return "Waiting: you will be woken when there is something to judge.";
  }
  if (input.action === "ask") {
    if (!input.question?.trim())
      throw refused(
        "The question for the person is missing.",
        "Give it with ask.",
      );
    return "Asked: the person's answer comes as their next message.";
  }
  if (input.action === "finish") {
    const open = stories.filter(
      (story) => story.status !== "done" && story.status !== "discarded",
    );
    if (open.length)
      throw refused(
        `The epic is not finished: ${open
          .map((story) => `${storyDisplayId(story)} (${story.status})`)
          .join(
            ", ",
          )} ${open.length === 1 ? "is" : "are"} neither merged nor rejected.`,
        "Approve or reject each first.",
      );
    if (!input.summary?.trim())
      throw refused(
        "The epic's summary for the person is missing.",
        "Give it with finish.",
      );
    return "Finished: the epic waits for the person's review.";
  }
  throw refused(
    "The way to end the turn is missing.",
    "Use wait, ask or finish.",
  );
}

// --------------------------------------------------------------- helpers

/** The epic and its stories as the API keeps them now. */
// While the epic is paused the orchestrator reads and talks with the
// person; nothing of the epic moves until the person resumes it.
const pausedThen =
  "Until the person resumes it you can read the epic and answer the person; end your turn with wait, and the resume wakes you.";

function assertActive(look: EpicReading, what: string, then = pausedThen) {
  if (look.epic.status === "paused")
    throw refused(`${what}: the epic is paused.`, then);
}

async function fresh(desk: EpicDesk): Promise<EpicReading> {
  const look = await desk.orchestrator.reading(desk.epicId);
  await desk.stories.refresh(look.epic.projectId);
  return look;
}

function epicStory(look: EpicReading, storyId: string): HostStory {
  const story = look
    .epicStories()
    .find((item) => item.id === storyId || storyDisplayId(item) === storyId);
  if (!story)
    throw refused(
      `${storyId} is not a story of this epic.`,
      "Name one of its stories by id or number.",
    );
  return story;
}

function assertBudget(spend: EpicSpend) {
  if (!spend.spent) return;
  throw refused(
    `The epic's budget is spent (${usd(spend.totalMicroUsd)} of ${usd(spend.budgetMicroUsd ?? 0)}), so nothing more starts.`,
    "Approve or reject what is in review, ask the person to raise the budget, or finish.",
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
      throw refused(
        `These stories start after each other in a cycle: ${[...path, story.key].join(" → ")}.`,
        "Break the cycle.",
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
    throw refused(
      "This project has no working preview environment, so its stories would run in the person's project folder on its own branch, not on the epic's branch.",
      "Ask the person to set up the preview environment first.",
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
    throw refused(
      "The story's intent is missing.",
      "Use cheaper, balanced or smarter.",
    );
  const fallback = desk.orchestrator.fallbackModel();
  const resolution = resolveModelIntent({
    ...pool,
    intent,
    fallback: fallback ?? { providerId: "", modelId: "" },
  });
  if (resolution.fallback && !fallback?.providerId)
    throw refused(
      "No model can run the stories: nothing ranked is in the epic's range, and the account has no agent model.",
      "Ask the person to connect a provider.",
    );
  // Nothing ranked: the account's model, only on a provider the epic allows.
  if (
    resolution.fallback &&
    (pool.providers?.length
      ? !pool.providers.includes(resolution.model.providerId)
      : false)
  )
    throw refused(
      `No model of the providers the epic allows (${pool.providers!.join(", ")}) can run the stories: nothing of theirs ranks in the epic's range, and the account's agent model is on ${resolution.model.providerId}.`,
      "Ask the person to widen the providers or the range.",
    );
  if (
    resolution.fallback &&
    pool.hidden?.some(
      (hidden) =>
        hidden.providerId === resolution.model.providerId &&
        hidden.modelId === resolution.model.modelId,
    )
  )
    throw refused(
      "No visible model can run the stories: nothing ranks in the epic's range, and the account's agent model is hidden.",
      "Ask the person.",
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
async function epicBranchReady(desk: EpicDesk, look: EpicReading) {
  const epic = look.epic;
  const branch = (await desk.state.get(desk.epicId))?.branch;
  if (!branch || !epic.targetBranch || epic.branch !== branch)
    throw refused(
      "Nothing starts: the epic's branch is not the one this computer made for it.",
      "Ask the person.",
    );
  const git = requiredGit(desk);
  const root = await workspaceRoot(desk);
  // Made again from the target only while nothing was merged into it: a
  // later story must never build without the work already merged.
  const merged = look.epicStories().some((story) => story.status === "done");
  if (merged && !(await hasBranch(git, root, branch)))
    throw refused(
      `Nothing starts: the epic's branch ${branch} is gone, and stories were already merged into it.`,
      "Ask the person to restore it.",
    );
  await ensureBranch(git, root, branch, epic.targetBranch);
}

async function hasBranch(git: GitRun, root: string, branch: string) {
  try {
    await git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A refusal read by two: the first sentence says what happened, in plain
 * words the person reads in the decision log; what the orchestrator should
 * do comes after it.
 */
function refused(what: string, then: string, cause?: unknown) {
  return new Error(`${what} ${then}`, cause ? { cause } : undefined);
}

function conflictWhere(error: Error) {
  const files = (error as { files?: unknown }).files;
  return Array.isArray(files) && files.length ? ` (${files.join(", ")})` : "";
}

// A merge Git could not undo says where it left the worktree.
function conflictLeft(error: Error) {
  const left = (error as { left?: unknown }).left;
  return typeof left === "string" && left ? ` ${left}` : "";
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
