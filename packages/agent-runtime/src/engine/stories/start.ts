// The start of a queued story: where it runs, what it needs first, its
// worktree, its session and its first message. It says why the story waits
// when it cannot start now; it throws when the start failed, after putting
// the story back in the queue. Whatever it leaves when it is cut short (a
// quit, a write that failed twice) the service's reconcile settles.

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
  storyLocation,
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
  /** The story as the API keeps it now (the service's cache learns it too). */
  read(storyId: string): Promise<HostStory>;
  /** Writes the story and tells the windows; resolves with the story as the API keeps it. */
  patch(
    story: HostStory,
    update: StoryUpdate,
    extra?: StoryEventExtra,
  ): Promise<HostStory>;
  /** The same, tried again a few times: for the writes a story must not miss. */
  patchDurably(story: HostStory, update: StoryUpdate): Promise<HostStory>;
  /** This computer runs the story (from its start on): only it settles the story. */
  own(story: HostStory, path: string, session?: string): Promise<void>;
  /** The story no longer runs here. */
  release(storyId: string): Promise<void>;
  /** A session the service made for a story: each turn it ends will be told. */
  sessionMade(session: string): Promise<void>;
  /** A session the service deleted. */
  sessionDropped(session: string): Promise<void>;
};

/** What a start did: started, or why the story waits. */
export type StartResult =
  { started: true } | { notReady: true } | { wait: StoryWaitReason };

export async function startStory(
  context: StoryContext,
  queued: HostStory,
  projectPath: string,
): Promise<StartResult> {
  const { api, desktop, preferences } = context;
  // The details (attachments, excerpts) and the status as the API has it now.
  const story = await context.read(queued.id);
  if (story.status !== "ready") return { notReady: true };
  const turn = storyTurnModel(story, preferences, undefined, true);
  if (!preferences || !turn) return { wait: { kind: "no-model" } };
  const snapshot = await api.initialization(story.projectId);
  let mode = story.runMode ?? preferences.runMode;
  const gate = initializationDecision(
    snapshot.initialization,
    mode,
    Date.now(),
    preferences.initializingProjects?.includes(story.projectId) ?? false,
  );
  if (gate === "wait") return { wait: { kind: "initialization" } };
  // No usable preview environment: run Direct rather than wait for one.
  if (gate === "run-direct") {
    await context.patch(story, { runMode: "direct" }, { directFallback: true });
    mode = "direct";
  }
  if (mode === "vercel-compose" && !preferences.premium)
    return { wait: { kind: "cloud-without-premium" } };
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
  if (runtime) return { wait: runtime };
  const report = await required(desktop.checkHostDependencies)({
    // A runtime the window cannot report on is checked here instead.
    includeRuntime:
      direct || preferences.runtimePhase !== "unavailable" ? false : undefined,
    runtimeProfile,
    workspaceMode,
  });
  if (!report.ok)
    return {
      wait: {
        kind: "host-dependencies",
        report,
        runtimeProfile,
        workspaceMode,
      },
    };
  // Git won't commit the story's work without a name and an email.
  const identity = await desktop
    .gitIdentity?.({ root: projectPath })
    .catch(() => undefined);
  if (identity?.available && !identity.configured)
    return { wait: { kind: "git-identity" } };

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
  // This computer runs it from now: a quit from here on is settled here.
  await context.own(story, projectPath);
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
  let session: string | undefined;
  try {
    const settings = storySessionSettings({
      story: { ...story, ...working },
      projectPath,
      snapshot,
      model: turn.model,
      maxContextTokens: turn.maxContextTokens,
      personalization: storyPersonalization(story, preferences),
    });
    // A story keeps one conversation: a requeued story continues it. A
    // session that never got its first message goes, so that the new one
    // starts with the story's brief.
    session = await reusableSession(
      context,
      story,
      storyLocation(worktree.workspaceMode),
    );
    const created = !session;
    session ??= randomUUID();
    await desktop.prepareStoryTurn?.({
      session,
      projectId: story.projectId,
      root: worktree.worktree,
      workspaceMode: worktree.workspaceMode,
      created,
      apiConnection: context.connection,
    });
    if (created) {
      await context.call("createSession", { session, ...settings });
      await context.sessionMade(session);
    }
    await context.own(story, projectPath, session);
    const { model } = settings.settings;
    // Said before the turn starts, so that the end of the turn settles it.
    await context.patchDurably(working, {
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
    // Back to the queue: its worktree is reused on the next attempt, and
    // its session too once it has its first message (else it is dropped
    // then). A write that fails here is the service's reconcile's to redo.
    const restored = await context
      .patchDurably(working, {
        agentLastError: errorMessage(error),
        agentStatus: null,
        engineSessionId: session ?? story.engineSessionId ?? null,
        status: "ready",
      })
      .then(
        () => true,
        () => false,
      );
    if (restored) await context.release(story.id).catch(() => undefined);
    throw error;
  }
  return { started: true };
}

// The story's session when it can go on: one the engine where the story now
// runs has, with turns.
async function reusableSession(
  context: StoryContext,
  story: HostStory,
  location: ReturnType<typeof storyLocation>,
) {
  const existing = story.engineSessionId;
  if (!existing) return undefined;
  const [status] = await context.call("status", {
    sessions: [existing],
    location,
  });
  if (status?.exists && status.turns > 0) return existing;
  if (status?.exists) {
    await context
      .call("deleteSession", { session: existing, location })
      .catch(() => undefined);
    await context.sessionDropped(existing);
  }
  return undefined;
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
