// The security audit's repository map: a scan of the project, no agent.
// The renderer runs the audit itself: its agent steps are engine tasks
// (`platform.engine`), which get the workspace this map reports.
import type {
  MapSecurityAuditInput,
  MapSecurityAuditResult,
  SecurityAuditWorkspaceMap,
} from "@blame/agent-runtime";
import { ipcMain } from "electron";
import { isAbsolute, resolve } from "node:path";

import { runtimeHostPath, runtimeManagedPath } from "./workspace-runtime";

export function registerSecurityAuditIpcHandlers(
  map: (input: MapSecurityAuditInput) => Promise<MapSecurityAuditResult>,
) {
  ipcMain.handle(
    "security-audits:map",
    async (_event, value): Promise<SecurityAuditWorkspaceMap> => {
      const { root, scope } = securityAuditMapRequest(value);
      // A project in the runtime VM is read through its path on this machine.
      const hostRoot = runtimeHostPath(root);
      const repository = await map({
        cwd: hostRoot,
        workspaceRoot: hostRoot,
        ...(scope ? { scope } : {}),
      });
      return {
        workspace: runtimeManagedPath(root) ? { root, inVm: true } : { root },
        repository,
      };
    },
  );
}

function securityAuditMapRequest(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("Security audit request is invalid");
  }
  const input = value as { root?: unknown; scope?: unknown };
  if (
    typeof input.root !== "string" ||
    !input.root ||
    !isAbsolute(input.root)
  ) {
    throw new Error("Security audit project root is invalid");
  }
  const scope = input.scope;
  if (scope !== undefined) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw new Error("Security audit scope is invalid");
    }
    const candidate = scope as { type?: unknown; paths?: unknown };
    if (
      (candidate.type !== "repository" && candidate.type !== "paths") ||
      (candidate.paths !== undefined &&
        (!Array.isArray(candidate.paths) ||
          candidate.paths.some((path) => typeof path !== "string")))
    ) {
      throw new Error("Security audit scope is invalid");
    }
  }
  return {
    root: resolve(input.root),
    scope: scope as MapSecurityAuditInput["scope"],
  };
}
