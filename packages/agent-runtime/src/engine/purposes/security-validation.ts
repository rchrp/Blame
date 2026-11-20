// The validator of a security audit: it merges the investigators' and the
// scanners' candidates, seeks counter-evidence in the code and reports the
// confirmed findings and the rejected candidates with
// `submit_security_validation`. Read-only, like the investigators.

import { loadPrompt } from "../../prompt-loader.js";
import {
  mergeSecurityCandidates,
  parseSecurityValidation,
} from "../../security-audit.js";
import { securityValidationResultSchema } from "../../security-audit-schema.js";
import type { ValidateSecurityAuditResult } from "../../types.js";
import type { ValidateSecurityAuditTask } from "../task-protocol.js";
import {
  resultObject,
  submitTool,
  taskConfig,
  type TaskSpec,
} from "../tasks/runner.js";
import {
  repositoryPacket,
  securityAuditSession,
} from "./security-discovery.js";

export const SECURITY_VALIDATION_TOOL = "submit_security_validation";

export function securityValidationTask(
  input: ValidateSecurityAuditTask,
): TaskSpec<ValidateSecurityAuditResult> {
  const candidates = mergeSecurityCandidates(input.discoveries);
  const { required, allowed, ...session } = securityAuditSession(input.mode, {
    standard: 32,
    deep: 48,
  });
  return {
    config: taskConfig({
      purpose: "security-validation",
      model: input.model,
      systemPrompt: loadPrompt("security-audit-validation-system"),
      workspace: input.workspace,
      ...session,
      contract: {
        result: submitTool(
          SECURITY_VALIDATION_TOOL,
          "Submit confirmed findings and rejected candidates.",
          securityValidationResultSchema(candidates.map(({ id }) => id)),
        ),
        required,
        allowed,
        max_corrections: 2,
      },
    }),
    instruction: [
      "Independently validate the canonical security candidates below.",
      "Seek counter-evidence, existing controls, reachability constraints, and framework behavior. Reject speculation. A reportable finding needs a concrete attack path, impact, affected location, and actionable remediation.",
      `Repository map: ${repositoryPacket(input.repository)}`,
      `Canonical candidates: ${JSON.stringify(candidates)}`,
    ].join("\n"),
    result: (value) =>
      parseSecurityValidation(
        resultObject(value),
        input.repository,
        input.discoveries,
      ),
  };
}
