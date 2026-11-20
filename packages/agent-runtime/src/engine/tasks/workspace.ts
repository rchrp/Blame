// The engine host's work with no agent in it, for the app: whether Open PR
// can run and what GitHub says of a pull request, the files a Direct story
// wrote, a security audit's repository map, and the MCP servers' sign-ins.

import { findDirectStoryFiles } from "../../direct-story-files.js";
import {
  pullRequestAvailability,
  readPullRequestState,
  type GhRunner,
} from "../../pull-request.js";
import { assertRepositoryPath, git } from "../../runtime-git.js";
import { scanSecurityAuditRepository } from "../../security-audit-scan.js";
import {
  authorizeMcpOAuth,
  clearMcpOAuth,
  listMcpOAuthStatuses,
} from "../tools/mcp-oauth.js";
import type { TaskHandlers } from "./handlers.js";

export type WorkspaceCallHost = {
  gh: GhRunner;
  /** Opens an MCP server's sign-in page in the person's browser. */
  openAuthorization(url: string): Promise<void>;
};

export function workspaceCallHandlers(
  host: WorkspaceCallHost,
): TaskHandlers<
  | "pullRequestAvailability"
  | "pullRequestState"
  | "directStoryFiles"
  | "mapSecurityAudit"
  | "mcpOAuthStatuses"
  | "mcpOAuthAuthorize"
  | "mcpOAuthClear"
> {
  return {
    pullRequestAvailability: async ({ repositoryRoot }) => {
      assertRepositoryPath(repositoryRoot, "repositoryRoot");
      return pullRequestAvailability(repositoryRoot, host.gh);
    },
    pullRequestState: async ({ repositoryRoot, url }) => {
      assertRepositoryPath(repositoryRoot, "repositoryRoot");
      return readPullRequestState(repositoryRoot, url, host.gh);
    },
    directStoryFiles: async (input) => {
      assertRepositoryPath(input.root, "root");
      return findDirectStoryFiles(input);
    },
    mapSecurityAudit: async ({ workspaceRoot }) => {
      assertRepositoryPath(workspaceRoot, "workspaceRoot");
      // Git through the host's runner: main's, which reaches the runtime VM.
      return scanSecurityAuditRepository(workspaceRoot, git);
    },
    mcpOAuthStatuses: ({ filePath }) => listMcpOAuthStatuses(filePath),
    mcpOAuthAuthorize: async ({ filePath, serverName }) => {
      await authorizeMcpOAuth({
        filePath,
        serverName,
        openUrl: host.openAuthorization,
      });
      return null;
    },
    mcpOAuthClear: async ({ filePath, serverName }) => {
      clearMcpOAuth(filePath, serverName);
      return null;
    },
  };
}
