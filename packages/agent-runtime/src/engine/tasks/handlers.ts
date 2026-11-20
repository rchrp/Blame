// The engine host's answers to the renderer's task calls
// (`EngineTaskMethods`): each builds its task from a purpose and runs it.

import { randomUUID } from "node:crypto";
import { runHostGh, type GhRunner } from "../../pull-request.js";
import type { EngineClient, ToolSpec } from "@blame/engine-client";
import { titleTask } from "../purposes/title.js";
import { userStoryTask } from "../purposes/user-story.js";
import type { EngineLocation } from "../protocol.js";
import type { EngineTaskMethods, TaskCall } from "../task-protocol.js";
import { gitTaskHandlers } from "./git.js";
import { projectTaskHandlers } from "./project.js";
import type { TaskRunner, TaskSpec } from "./runner.js";
import { securityAuditTaskHandlers } from "./security-audit.js";
import { workspaceCallHandlers, type WorkspaceCallHost } from "./workspace.js";

export type TaskHost = {
  runner: TaskRunner;
  /** Specs of the app's own client tools (web research), by name. */
  clientTools(names: readonly string[]): ToolSpec[];
  /** The engine of a location (this computer's by default). */
  client(location?: EngineLocation): Promise<EngineClient>;
  /** What the credential and log handlers need to know of a session. */
  register(
    session: string,
    known: { projectId?: string; credentialLabel?: string },
  ): void;
  /** Drops what the host keeps of a deleted session. */
  forget(session: string): void;
  /** gh for Open PR; the person's own, on this machine, by default. */
  gh?: GhRunner;
} & Omit<WorkspaceCallHost, "gh">;

export type TaskHandlers<
  Methods extends keyof EngineTaskMethods = keyof EngineTaskMethods,
> = {
  [M in Methods]: (
    input: EngineTaskMethods[M]["input"],
  ) => Promise<EngineTaskMethods[M]["result"]>;
};

export function taskHandlers(host: TaskHost): TaskHandlers {
  const run = <R>(call: TaskCall, spec: TaskSpec<R>, what: string) => {
    const session = call.task ?? `task-${randomUUID()}`;
    host.register(session, {
      projectId: call.projectId,
      credentialLabel: call.model.credentialLabel,
    });
    return host.runner.run(spec, { session, what });
  };
  return {
    ...gitTaskHandlers(host, host.gh),
    ...workspaceCallHandlers({ ...host, gh: host.gh ?? runHostGh }),
    generateTitle: async (input) => {
      const { session, result } = await run(
        input,
        titleTask(input),
        "The title generator",
      );
      return { session, ...result };
    },
    optimizeUserStory: async (input) => {
      const { session, result } = await run(
        input,
        userStoryTask(input),
        "The user story optimizer",
      );
      return { session, ...result };
    },
    ...securityAuditTaskHandlers(run),
    ...projectTaskHandlers(host),
    cancelTask: async ({ session }) => host.runner.cancel(session),
    deleteSession: async ({ session, location }) => {
      await (await host.client(location)).deleteSession({ session });
      host.forget(session);
      return null;
    },
  };
}
