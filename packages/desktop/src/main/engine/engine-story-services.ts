// What the story service in the engine host asks of the main process to run
// a development story (docs/engine-in-the-app.md, "Development stories"):
// its worktree, what this computer needs for its mode, Git's identity, what
// a turn needs before it starts (the development server, the preview's
// sync, the session's GitHub access), what Approve & Merge needs, the
// cleanup of what the story ran once it is done, discarded or deleted, and
// whether a story's worktree is on this computer.

import { randomUUID } from "node:crypto";
import log from "electron-log";

import type {
  EngineDesktopMethod,
  EngineDesktopMethods,
} from "@blame/agent-runtime/engine-protocol";
import { beginEngineGitFlow, endEngineGitFlow } from "../agent-ipc.ts";
import { readGitIdentity } from "../git-identity.ts";
import { deviceRuntime } from "../preview-devices/device-runtime.ts";
import { prepareSessionGithubAccess } from "../ipc/agent-github-access-ipc.ts";
import { requestDevelopmentServing } from "../preview-runtime/local/local-preview-serving.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import {
  checkWorkspaceHostDependencies,
  createStoryWorktree,
  readStoryWorkspaceFile,
  removeStoryWorktree,
  stopStoryProjectSetup,
  storyWorktreeHere,
} from "../workspace-ipc.ts";

type StoryServiceName =
  | "createStoryWorktree"
  | "checkHostDependencies"
  | "gitIdentity"
  | "prepareStoryTurn"
  | "stopStoryRuntime"
  | "removeStoryWorktree"
  | "storyWorktreeHere"
  | "readWorkspaceFile"
  | "beginGitFlow"
  | "endGitFlow";

type Handlers = {
  [M in Extract<EngineDesktopMethod, StoryServiceName>]: (
    input: EngineDesktopMethods[M]["input"],
    signal: AbortSignal,
  ) => Promise<EngineDesktopMethods[M]["result"]>;
};

export function engineStoryServices(previews: PreviewService): Handlers {
  return {
    createStoryWorktree: (input) => createStoryWorktree(input),
    checkHostDependencies: (input) =>
      checkWorkspaceHostDependencies(input) as Promise<{ ok: boolean }>,
    gitIdentity: async (input) => {
      const identity = await readGitIdentity({ root: input.root });
      return { available: identity.available, configured: identity.configured };
    },
    prepareStoryTurn: async (input) => {
      await prepareStoryTurn(previews, input);
      return null;
    },
    stopStoryRuntime: (input) => stopStoryRuntime(previews, input),
    removeStoryWorktree: async (input) => {
      const removed = await removeStoryWorktree({
        ...input,
        workspaceMode: input.workspaceMode ?? undefined,
      });
      if (!removed) throw new Error("Unable to remove worktree.");
      return true;
    },
    storyWorktreeHere: (input) =>
      storyWorktreeHere({
        ...input,
        workspaceMode: input.workspaceMode ?? undefined,
      }),
    readWorkspaceFile: (input) => readStoryWorkspaceFile(input),
    beginGitFlow: (input) =>
      beginEngineGitFlow(input.worktree, (worktree) =>
        previews.syncBarrier(worktree),
      ),
    endGitFlow: async (input) => {
      endEngineGitFlow(input.operation);
      return null;
    },
  };
}

/** What a story runs besides its agent, stopped: its setup, preview, devices and cloud preview. */
async function stopStoryRuntime(
  previews: PreviewService,
  input: EngineDesktopMethods["stopStoryRuntime"]["input"],
) {
  const [projectSetupStopped] = await Promise.all([
    input.worktree
      ? stopStoryProjectSetup({
          workspaceMode: input.workspaceMode ?? undefined,
          worktree: input.worktree,
        }).catch(() => false)
      : false,
    deviceRuntime()
      .service.stop(input.storyId, true)
      .catch(() => undefined),
    input.workspaceMode === "cloud-mirror"
      ? stopCloudPreview(previews, input.storyId)
      : undefined,
  ]);
  return { projectSetupStopped };
}

async function stopCloudPreview(previews: PreviewService, storyId: string) {
  try {
    const { session } = await previews.findForUserStory(
      storyId,
      "vercel-compose",
    );
    if (session)
      await previews.command(
        session.id,
        { type: "suspend-host" },
        randomUUID(),
      );
  } catch (error) {
    log.warn("Unable to stop the story's cloud preview", error);
  }
}

/** A story that changes again needs its development server back and its preview synced. */
export async function prepareStoryTurn(
  previews: PreviewService,
  input: EngineDesktopMethods["prepareStoryTurn"]["input"],
) {
  void requestDevelopmentServing(input.root).catch(() => undefined);
  await previews.syncBarrier(input.root);
  // The story's tools reach GitHub under its engine session id.
  if (input.created)
    await prepareSessionGithubAccess({
      sessionId: input.session,
      projectId: input.projectId,
      workspaceMode: input.workspaceMode,
      workspaceRoot: input.root,
      apiConnection: input.apiConnection,
    });
}
