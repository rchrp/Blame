// The engine host's answers to the renderer's task calls
// (`EngineTaskMethods`): each builds its task from a purpose and runs it.

import { randomUUID } from "node:crypto";
import type { EngineClient } from "@blame/engine-client";
import { titleTask } from "../purposes/title.js";
import { userStoryTask } from "../purposes/user-story.js";
import type { EngineTaskMethods, TaskCall } from "../task-protocol.js";
import type { TaskRunner, TaskSpec } from "./runner.js";

export type TaskHost = {
  runner: TaskRunner;
  client(): Promise<EngineClient>;
  /** What the credential and log handlers need to know of a session. */
  register(
    session: string,
    known: { projectId?: string; credentialLabel?: string },
  ): void;
  /** Drops what the host keeps of a deleted session. */
  forget(session: string): void;
};

type Handlers = {
  [M in keyof EngineTaskMethods]: (
    input: EngineTaskMethods[M]["input"],
  ) => Promise<EngineTaskMethods[M]["result"]>;
};

export function taskHandlers(host: TaskHost): Handlers {
  const run = <R>(call: TaskCall, spec: TaskSpec<R>, what: string) => {
    const session = call.task ?? `task-${randomUUID()}`;
    host.register(session, {
      projectId: call.projectId,
      credentialLabel: call.model.credentialLabel,
    });
    return host.runner.run(spec, { session, what });
  };
  return {
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
    cancelTask: async ({ session }) => host.runner.cancel(session),
    deleteSession: async ({ session }) => {
      await (await host.client()).deleteSession({ session });
      host.forget(session);
      return null;
    },
  };
}
