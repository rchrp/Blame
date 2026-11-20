// The engine host's answers to the agent steps of a security audit: each
// investigator and the validator is a task of its own, which the renderer
// follows for its progress and stops with `cancelTask`. The repository map
// is no agent: it stays a scan of the desktop's (`securityAudits.map`).

import { securityDiscoveryTask } from "../purposes/security-discovery.js";
import { securityValidationTask } from "../purposes/security-validation.js";
import type { EngineTaskMethods, TaskCall } from "../task-protocol.js";
import type { TaskSpec } from "./runner.js";

type RunTask = <R>(
  call: TaskCall,
  spec: TaskSpec<R>,
  what: string,
) => Promise<{ session: string; result: R }>;

type Methods = "discoverSecurityAudit" | "validateSecurityAudit";

export function securityAuditTaskHandlers(run: RunTask): {
  [M in Methods]: (
    input: EngineTaskMethods[M]["input"],
  ) => Promise<EngineTaskMethods[M]["result"]>;
} {
  return {
    discoverSecurityAudit: async (input) => {
      const { session, result } = await run(
        input,
        securityDiscoveryTask(input),
        "The security investigator",
      );
      return { session, ...result };
    },
    validateSecurityAudit: async (input) => {
      const { session, result } = await run(
        input,
        securityValidationTask(input),
        "The security validator",
      );
      return { session, ...result };
    },
  };
}
