// The start of a queued story: where it runs, what it needs first, its
// worktree, its session and its first message. It returns why it waits
// when it cannot start now; it throws when the start failed.

import { randomUUID } from "node:crypto";
import type { ApiConnection } from "../../types.js";
import type { DesktopServices } from "../desktop-services.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
} from "../protocol.js";
import type {
  StoryHostEvent,
  StoryPreferences,
  StoryWaitReason,
} from "../story-protocol.js";
import type { StoryApi } from "./api.js";
import { initializationDecision, runtimeWait } from "./queue.js";
import {
  storyPersonalization,
  storySessionSettings,
  storyTurnModel,
} from "./settings.js";
import {
  storyDisplayId,
  storyMessage,
  withAgentModel,
  type HostStory,
  type StoryUpdate,
} from "./story.js";

export type StoryEventExtra = Omit<
  Extract<StoryHostEvent, { type: "story" }>,
  "type" | "projectId" | "storyId" | "story"
>;

/** What the service gives a start, a turn or an ending. */
export type StoryContext = {
  api: StoryApi;
  connection: ApiConnection;
  preferences: StoryPreferences | undefined;
  desktop: DesktopServices;
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  /** Writes the story and tells the windows; resolves with the story as the API keeps it. */
  patch(
    story: HostStory,
    update: StoryUpdate,
    extra?: StoryEventExtra,
  ): Promise<HostStory>;
};

export async function startStory(
  context: StoryContext,
  queued: HostStory,
  projectPath: string,
): Promise<StoryWaitReason | undefined> {
  const { api, desktop, preferences } = context;
  // The details: its attachments and code excerpts.
  const { story } = await api.get(queued.id);
  if (story.status !== "ready") return undefined;
  if (!preferences) return { kind: "no-model" };
  const turn = storyTurnModel(story, preferences, undefined, true);
  if (!turn) return { kind: "no-model" };
  const snapshot = await api.initialization(story.projectId);
  let mode = story.runMode ?? preferences.runMode;
  const gate = initializationDecision(snapshot.initialization, mode);
  if (gate === "wait") return { kind: "initialization" };
  // No usable preview environment: run Direct rather than wait for one.
  if (gate === "run-direct") {
    await context.patch(story, { runMode: "direct" }, { directFallback: true });
    mode = "direct";
  }
  if (mode === "vercel-compose" && !preferences.premium)
    return { kind: "cloud-without-premium" };
  const direct = mode === "direct";
  const runtimeProfile =
    mode === "vercel-compose" ? "vercel-compose" : "local-container";
  const workspaceMode = direct
    ? "direct"
    : mode === "local-container"
      ? "local-container"
      : "cloud-mirror";
  // Local Container stories wait for the Blame Runtime (or ask for it).
  const runtime = direct
    ? undefined
    : runtimeWait(mode, preferences.runtimePhase);
  if (runtime) return runtime;
  const report = await required(desktop.checkHostDependencies)({
    // A runtime the window cannot report on is checked here instead.
    includeRuntime:
      direct || preferences.runtimePhase !== "unavailable" ? false : undefined,
    runtimeProfile,
    workspaceMode,
  });
  if (!report.ok)
    return { kind: "host-dependencies", report, runtimeProfile, workspaceMode };
  // Git won't commit the story's work without a name and an email.
  const identity = await desktop
    .gitIdentity?.({ root: projectPath })
    .catch(() => undefined);
  if (identity?.available && !identity.configured)
    return { kind: "git-identity" };

  const worktree = await required(desktop.createStoryWorktree)({
    branch: story.branch,
    // Direct runs in the project folder: no new worktree or branch.
    direct,
    repositoryRoot: projectPath,
    runtimeProfile,
    storyId: story.id,
    storyReference: storyDisplayId(story),
    targetBranch: story.targetBranch,
    title: story.title,
  });
  const baseCommit = await desktop
    .git?.({ cwd: worktree.worktree, args: ["rev-parse", "HEAD"] })
    .then((hash) => hash.trim() || null)
    .catch(() => null);
  const working = await context.patch(
    story,
    {
      baseCommit: baseCommit ?? null,
      branch: worktree.branch,
      // Kept from the first run on: the story merges back where it started.
      // Direct works on the project folder's branch, whatever was chosen.
      targetBranch: direct
        ? worktree.targetBranch
        : (story.targetBranch ?? worktree.targetBranch),
      status: "in-progress",
      workspaceMode: worktree.workspaceMode,
      worktree: worktree.worktree,
    },
    // Its preview waits for the environment to be checked; its agent starts.
    direct ? {} : { started: { environment: snapshot.initialization } },
  );
  const settings = storySessionSettings({
    story: { ...story, ...working },
    projectPath,
    snapshot,
    model: turn.model,
    maxContextTokens: turn.maxContextTokens,
    personalization: storyPersonalization(story, preferences),
  });
  // A story keeps one conversation: a requeued story continues it.
  const existing = story.engineSessionId;
  const session = existing ?? randomUUID();
  try {
    await desktop.prepareStoryTurn?.({
      session,
      projectId: story.projectId,
      root: worktree.worktree,
      workspaceMode: worktree.workspaceMode,
      created: !existing,
      apiConnection: context.connection,
    });
    if (!existing)
      await context.call("createSession", { session, ...settings });
    // Stopped, dequeued or discarded while it was starting: let it go.
    if (!(await stillStarting(context, story.id))) return undefined;
    const { model } = settings.settings;
    await context.patch(story, {
      agentLastError: null,
      agentModels: withAgentModel(story.agentModels, {
        modelId: model.modelId,
        providerId: model.providerId,
        reasoningEffort: model.reasoning ?? null,
      }),
      agentStatus: "Running",
      engineSessionId: session,
    });
    await context.call("send", {
      session,
      message: await storyMessage(
        story.summary,
        story.codeSelectionAttachments,
        story.fileAttachments,
        (file) => api.attachment(file.id, file.name),
      ),
      delivery: "turn",
      settings,
    });
  } catch (error) {
    // Back to the queue: its worktree and its conversation are reused on
    // the next attempt.
    if (await stillStarting(context, story.id))
      await context
        .patch(story, {
          agentLastError: errorMessage(error),
          agentStatus: null,
          ...(existing ? {} : { engineSessionId: null }),
          status: "ready",
        })
        .catch(() => undefined);
    throw error;
  }
  return undefined;
}

// Still the story this start moved to In Progress, untouched since.
async function stillStarting(context: StoryContext, storyId: string) {
  const { story } = await context.api.get(storyId);
  return story.status === "in-progress" && story.agentStatus !== "Paused";
}

function required<Input, Output>(
  service: ((input: Input) => Promise<Output>) | undefined,
) {
  if (!service)
    throw new Error("The desktop cannot run development stories here.");
  return service;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
