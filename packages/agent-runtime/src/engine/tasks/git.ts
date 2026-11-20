// The engine host's answers to the git flows (`approveAndMerge`,
// `openPullRequest`, `generateCommitMessage`, `resolveMergeConflicts`): the
// flow runs here, and each of its agent steps is an engine task of its own.

import { randomUUID } from "node:crypto";
import { runHostGh, type GhRunner } from "../../pull-request.js";
import type { GitAgent } from "../git/agent.js";
import { generateCommitMessage } from "../git/commit-message.js";
import { resolveMergeConflicts } from "../git/merge-conflicts.js";
import { openPullRequest } from "../git/pull-request.js";
import { approveAndMerge } from "../git/story-merge.js";
import type { EngineTaskMethods } from "../task-protocol.js";
import type { TaskHost } from "./handlers.js";

type GitMethod =
  | "approveAndMerge"
  | "openPullRequest"
  | "generateCommitMessage"
  | "resolveMergeConflicts";

export function gitTaskHandlers(
  host: TaskHost,
  gh: GhRunner = runHostGh,
): {
  [M in GitMethod]: (
    input: EngineTaskMethods[M]["input"],
  ) => Promise<EngineTaskMethods[M]["result"]>;
} {
  const agent: GitAgent = (call, spec, what) => {
    const session = `task-${randomUUID()}`;
    host.register(session, {
      projectId: call.projectId,
      credentialLabel: call.model.credentialLabel,
    });
    return host.runner.run(spec, { session, what });
  };
  return {
    approveAndMerge: (input) => approveAndMerge(input, agent),
    openPullRequest: (input) => openPullRequest(input, { agent, gh }),
    generateCommitMessage: (input) => generateCommitMessage(input, agent),
    resolveMergeConflicts: (input) => resolveMergeConflicts(input, agent),
  };
}
