// One investigator of a security audit: it reads the project's code from
// one perspective and reports evidence-backed candidates with
// `submit_security_discovery`. It works read-only, with the harness's search
// and read tools, and the engine accepts its result only after it has read
// code.

import { loadPrompt } from "../../prompt-loader.js";
import { parseSecurityDiscovery } from "../../security-audit.js";
import { securityDiscoveryResultSchema } from "../../security-audit-schema.js";
import type {
  MapSecurityAuditResult,
  SecurityAuditDiscoveryResult,
  SecurityAuditMode,
} from "../../types.js";
import type { DiscoverSecurityAuditTask } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskConfigInput,
  type TaskSpec,
} from "../tasks/runner.js";

export const SECURITY_DISCOVERY_TOOL = "submit_security_discovery";

/**
 * What every agent of an audit may do: search and read the project with
 * the harness, nothing else, and read before it answers.
 */
export function securityAuditSession(
  mode: SecurityAuditMode,
  requests: { standard: number; deep: number },
): Pick<TaskConfigInput, "engineTools" | "toolOptions" | "limits"> & {
  required: string[];
  allowed: string[];
} {
  const deep = mode === "deep";
  return {
    engineTools: ["harness"],
    toolOptions: {
      harness: {
        taskContract: {
          environment: { isolated: false, managedPreview: false },
          effect_requirement: "none",
        },
      },
    },
    required: ["read_code"],
    allowed: ["search_code", "read_code"],
    limits: {
      max_requests_per_turn: deep ? requests.deep : requests.standard,
      max_turn_ms: deep ? 1_800_000 : 1_200_000,
    },
  };
}

/** What the agents are told of the repository: its revision and surface. */
export function repositoryPacket(repository: MapSecurityAuditResult) {
  return JSON.stringify({
    revision: repository.revision,
    surfaceMap: repository.surfaceMap,
  });
}

export function securityDiscoveryTask(
  input: DiscoverSecurityAuditTask,
): TaskSpec<SecurityAuditDiscoveryResult> {
  const { required, allowed, ...session } = securityAuditSession(input.mode, {
    standard: 28,
    deep: 40,
  });
  return {
    config: taskConfig({
      purpose: "security-discovery",
      model: input.model,
      systemPrompt: loadPrompt("security-audit-discovery-system"),
      workspace: input.workspace,
      ...session,
      contract: {
        result: submitTool(
          SECURITY_DISCOVERY_TOOL,
          "Submit all security discovery candidates and coverage evidence.",
          securityDiscoveryResultSchema,
        ),
        required,
        allowed,
        max_corrections: 2,
      },
    }),
    instruction: [
      `Perform an independent ${input.perspective.replaceAll("_", " ")} security discovery pass.`,
      "Use the repository map to choose the code to inspect.",
      "Report candidates, not confirmed vulnerabilities. Trace attacker input to a sensitive operation and record concrete evidence. Do not report generic hardening advice.",
      `Repository map: ${repositoryPacket(input.repository)}`,
    ].join("\n"),
    result: (value) =>
      parseSecurityDiscovery(resultObject(value), input.perspective),
  };
}
