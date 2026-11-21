// What the story service in the engine host asks of the main process to run
// a development story (docs/engine-in-the-app.md, "Development stories"):
// its worktree, what this computer needs for its mode, Git's identity, and
// what a turn needs before it starts (the development server, the preview's
// sync, the session's GitHub access).

import type {
  EngineDesktopMethod,
  EngineDesktopMethods,
} from "@blame/agent-runtime/engine-protocol";
import { readGitIdentity } from "../git-identity.ts";
import { prepareSessionGithubAccess } from "../ipc/agent-github-access-ipc.ts";
import { requestDevelopmentServing } from "../preview-runtime/local/local-preview-serving.ts";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import {
  checkWorkspaceHostDependencies,
  createStoryWorktree,
} from "../workspace-ipc.ts";

type StoryServiceName =
  | "createStoryWorktree"
  | "checkHostDependencies"
  | "gitIdentity"
  | "prepareStoryTurn";

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
  };
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
