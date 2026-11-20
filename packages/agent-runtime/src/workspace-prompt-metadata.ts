import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Workspace metadata for a system prompt: the folder, its Git remotes and
 * branch, without the latest commit hash. The system prompt is the cache
 * prefix of every request: a commit between two turns would otherwise
 * discard the provider's prompt cache and, with Claude Code, restart its
 * process and replay the whole conversation.
 */
export async function workspacePromptMetadata(cwd: string) {
  const root = resolve(cwd);
  const workspace: Record<string, unknown> = { hint: basename(root) };
  // A folder that is not there yet (a VM workspace) has no Git metadata.
  const git = async (args: string[]) => {
    try {
      const { stdout } = await run("git", args, { cwd: root, timeout: 10_000 });
      return stdout.trim();
    } catch {
      return undefined;
    }
  };
  if ((await git(["rev-parse", "--is-inside-work-tree"])) === "true") {
    const [remotes, branch] = await Promise.all([
      git(["remote", "-v"]),
      git(["branch", "--show-current"]),
    ]);
    const urls = remoteUrls(remotes ?? "");
    if (urls.length) workspace.associatedRemoteUrls = urls;
    if (branch) workspace.latestGitBranchName = branch;
  }
  return JSON.stringify({ workspaces: { [root]: workspace } }, null, 2);
}

// `origin	git@github.com:acme/app.git (fetch)` → `origin: git@github.com:acme/app.git`
function remoteUrls(output: string) {
  const urls = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (match && (match[3] === "fetch" || !urls.has(match[1]!)))
      urls.set(match[1]!, match[2]!);
  }
  return [...urls].map(([name, url]) => `${name}: ${url}`);
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
