import { buildWorkspaceMetadata } from "@cline/sdk";

/**
 * Workspace metadata for a system prompt, without the latest commit hash.
 * The system prompt is the cache prefix of every request: a commit between
 * two turns would otherwise discard the provider's prompt cache and, with
 * Claude Code, restart its process and replay the whole conversation.
 */
export async function workspacePromptMetadata(cwd: string) {
  return withoutCommitHash(await buildWorkspaceMetadata(cwd));
}

export function withoutCommitHash(metadata: string) {
  try {
    const parsed = JSON.parse(metadata) as { workspaces?: Record<string, Record<string, unknown>> };
    if (!parsed.workspaces || typeof parsed.workspaces !== "object") return metadata;
    for (const workspace of Object.values(parsed.workspaces))
      if (workspace && typeof workspace === "object") delete workspace.latestGitCommitHash;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return metadata.replace(/^[ \t]*"latestGitCommitHash":[^\n]*\n/mu, "");
  }
}
