// What the engine host's git flows (approve and merge, open a pull request,
// write a commit message, resolve merge conflicts) need from the host: a way
// to run one engine task for an agent step, and the person's gh.

import type { GhRunner } from "../../pull-request.js";
import type { GitFlowCall } from "../task-protocol.js";
import type { TaskSpec } from "../tasks/runner.js";

/** Runs one agent step of a flow as an engine task; rejects with `EngineTaskError`. */
export type GitAgent = <R>(
  call: Pick<GitFlowCall, "model" | "projectId">,
  spec: TaskSpec<R>,
  what: string,
) => Promise<{ session: string; result: R }>;

export type GitFlowServices = { agent: GitAgent; gh: GhRunner };
