import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withoutTelemetryEnvironment } from "@blame/telemetry";

import { git } from "./runtime-git.js";
import type { PullRequestAvailability } from "./types.js";

// Open PR runs gh on this computer, with the person's own gh sign-in. No
// token is read or handed to the agent: gh authenticates itself.

export type GhRunner = (cwd: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

// GitHub refuses pull request bodies longer than this.
const pullRequestBodyLimit = 65_536;
const truncationNotice = "\n\n_[truncated]_";

const ghMissingMessage =
  "The GitHub CLI (gh) isn't installed on this computer. Install it from https://cli.github.com, run `gh auth login` in a terminal, then open the pull request again.";
const ghSignedOutMessage =
  "The GitHub CLI (gh) isn't signed in to github.com on this computer. Run `gh auth login` in a terminal, then open the pull request again.";

export async function runHostGh(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    env: {
      ...withoutTelemetryEnvironment(process.env),
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
    },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return stdout;
}

// owner/name of a github.com remote URL, in any of the forms Git accepts.
export function githubRepository(url: string) {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(
      url.trim(),
    ) ??
    /^(?:[^@/]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function pullRequestAvailability(
  repositoryRoot: string,
  gh: GhRunner,
): Promise<PullRequestAvailability> {
  const repository = await originGithubRepository(repositoryRoot);
  if (!repository) return { status: "not-github" };
  try {
    await gh(repositoryRoot, ["auth", "status", "--hostname", "github.com"]);
  } catch (error) {
    // gh's output may describe the account: only its absence is told apart.
    return errorCode(error) === "ENOENT"
      ? { status: "gh-missing", message: ghMissingMessage }
      : { status: "gh-signed-out", message: ghSignedOutMessage };
  }
  return { status: "available", repository };
}

// The GitHub repository a pull request goes to, or why there is none.
export async function requirePullRequestRepository(
  repositoryRoot: string,
  gh: GhRunner,
) {
  const availability = await pullRequestAvailability(repositoryRoot, gh);
  if (availability.status === "available") return availability.repository;
  if (availability.status === "not-github")
    throw new Error(
      "Open PR needs a Git remote named origin on github.com.",
    );
  throw new Error(availability.message);
}

export async function openPullRequestUrl(
  repositoryRoot: string,
  repository: string,
  storyBranch: string,
  gh: GhRunner,
) {
  const output = await gh(repositoryRoot, [
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    storyBranch,
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "1",
  ]);
  const parsed: unknown = JSON.parse(output || "[]");
  if (!Array.isArray(parsed))
    throw new Error("gh pr list returned an unexpected answer.");
  const url: unknown = parsed[0]?.url;
  return typeof url === "string" && url ? url : undefined;
}

export async function createPullRequest(
  repositoryRoot: string,
  input: {
    body: string;
    repository: string;
    storyBranch: string;
    targetBranch: string;
    title: string;
  },
  gh: GhRunner,
) {
  const output = await gh(repositoryRoot, [
    "pr",
    "create",
    "--repo",
    input.repository,
    "--base",
    input.targetBranch,
    "--head",
    input.storyBranch,
    "--title",
    input.title,
    "--body",
    input.body,
  ]);
  const url = output
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => /^https:\/\/\S+$/u.test(line));
  if (!url) throw new Error("gh pr create did not print the pull request URL.");
  return url;
}

// The story, its acceptance criteria and what the agent says it did.
export function pullRequestBody(story: {
  summary: string;
  agentSummary?: string;
}) {
  const { description, acceptanceCriteria } = splitAcceptanceCriteria(
    story.summary,
  );
  const agentSummary = story.agentSummary?.trim();
  const body = [
    description && `## Story\n\n${description}`,
    acceptanceCriteria && `## Acceptance criteria\n\n${acceptanceCriteria}`,
    agentSummary && `## Agent summary\n\n${agentSummary}`,
    "---\n_Opened from Blame._",
  ]
    .filter(Boolean)
    .join("\n\n");
  return body.length <= pullRequestBodyLimit
    ? body
    : `${body.slice(0, pullRequestBodyLimit - truncationNotice.length)}${truncationNotice}`;
}

const acceptanceCriteriaHeading =
  /^(#{1,6})\s+(?:acceptance criteria|crit[eè]res d['’]acceptation)\s*:?\s*$/iu;

function headingLevel(line: string) {
  return /^(#{1,6})\s/u.exec(line)?.[1]?.length;
}

// The acceptance criteria section runs to the next heading of its level or
// above; the rest of the story stays its description.
function splitAcceptanceCriteria(summary: string) {
  const lines = summary.split("\n");
  const start = lines.findIndex((line) => acceptanceCriteriaHeading.test(line));
  const level = start < 0 ? undefined : headingLevel(lines[start] ?? "");
  if (level === undefined)
    return { description: summary.trim(), acceptanceCriteria: "" };
  const relativeEnd = lines.slice(start + 1).findIndex((line) => {
    const next = headingLevel(line);
    return next !== undefined && next <= level;
  });
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return {
    description: [...lines.slice(0, start), ...lines.slice(end)]
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    acceptanceCriteria: lines
      .slice(start + 1, end)
      .join("\n")
      .trim(),
  };
}

async function originGithubRepository(repositoryRoot: string) {
  try {
    return githubRepository(
      await git(repositoryRoot, ["remote", "get-url", "origin"]),
    );
  } catch {
    // No origin remote.
    return undefined;
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
