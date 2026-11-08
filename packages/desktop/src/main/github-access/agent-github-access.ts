import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { setupPath } from "../host-tool-path.ts";

// GitHub access for the agent, per project and off by default. When a Local
// Container session starts in a project that turned it on, the desktop reads
// `gh auth token` on this computer and keeps the token in memory for that
// session. It is never written to the worktree, Git configuration or an env
// file, and where it goes depends on the project's level:
// - read: only to GitHub's remote MCP server, in read-only mode, from this
//   process (github-mcp-service). The agent's commands get no GitHub token,
//   which is what makes it read-only: the MCP mode only filters tools.
// - write: each of the session's managed runtime requests carries it, and the
//   runtime gives it to the agent's commands as GH_TOKEN.

export type AgentGithubAccessLevel = "off" | "read" | "write";
type GrantedLevel = Exclude<AgentGithubAccessLevel, "off">;

// US-073 stored the projects with access as a list: that access is "write".
type SettingsFile = { projects?: string[] | Record<string, unknown> };

export class AgentGithubAccessSettings {
  private readonly file: string;
  private cache?: Promise<Map<string, GrantedLevel>>;

  constructor(file: string) {
    this.file = file;
  }

  async level(projectId: string | undefined): Promise<AgentGithubAccessLevel> {
    if (!validProjectId(projectId)) return "off";
    return (await this.projects()).get(projectId) ?? "off";
  }

  // The level comes from the renderer: anything else is rejected.
  async setLevel(projectId: string, level: unknown) {
    if (!validProjectId(projectId)) throw new Error("Invalid project id.");
    if (!validLevel(level)) throw new Error("Invalid GitHub access level.");
    const projects = new Map(await this.projects());
    if (level !== "off") projects.set(projectId, level);
    else projects.delete(projectId);
    const content: SettingsFile = {
      projects: Object.fromEntries(
        [...projects].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(content, null, 2));
    await rename(temporary, this.file);
    this.cache = Promise.resolve(projects);
    return level;
  }

  private projects() {
    this.cache ??= readFile(this.file, "utf8")
      .then((value) => parseSettings(JSON.parse(value) as SettingsFile))
      .catch(() => new Map<string, GrantedLevel>());
    return this.cache;
  }
}

function parseSettings(settings: SettingsFile) {
  const projects = settings?.projects;
  const entries: [unknown, unknown][] = Array.isArray(projects)
    ? projects.map((projectId) => [projectId, "write"])
    : projects && typeof projects === "object"
      ? Object.entries(projects)
      : [];
  return new Map(
    entries.filter(
      (entry): entry is [string, GrantedLevel] =>
        validProjectId(entry[0]) && (entry[1] === "read" || entry[1] === "write"),
    ),
  );
}

export type HostGithubToken = { token: string } | { unavailable: string };

type RunHostGh = (args: string[]) => Promise<{ stdout: string }>;

const ghMissingMessage =
  "GitHub access for the agent is on, but the GitHub CLI (gh) isn't installed on this computer. This session runs without GitHub access; install gh, run `gh auth login`, then start a new session.";
const ghSignedOutMessage =
  "GitHub access for the agent is on, but the GitHub CLI (gh) isn't signed in on this computer. This session runs without GitHub access; run `gh auth login`, then start a new session.";

/** The token `gh auth token` prints on this computer, or why there is none. */
export async function readHostGithubToken(
  runGh: RunHostGh = runHostGh,
): Promise<HostGithubToken> {
  try {
    const token = (await runGh(["auth", "token"])).stdout.trim();
    if (token) return { token };
  } catch (error) {
    // The error carries gh's output: it is never logged.
    if (errorCode(error) === "ENOENT") return { unavailable: ghMissingMessage };
  }
  return { unavailable: ghSignedOutMessage };
}

const execFileAsync = promisify(execFile);

function runHostGh(args: string[]) {
  return execFileAsync("gh", args, {
    env: { ...process.env, PATH: setupPath() },
    timeout: 15_000,
    windowsHide: true,
  });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

// Session id -> the token granted when the session started, and its level.
const sessionGrants = new Map<string, { level: GrantedLevel; token: string }>();

export type SessionGithubAccessDependencies = {
  level(projectId: string): Promise<AgentGithubAccessLevel>;
  readToken(): Promise<HostGithubToken>;
};

/**
 * Decides a session's GitHub access as it starts (or resumes): a Local
 * Container session in a project that turned it on gets the host's token, at
 * the project's level. The notice explains a missing gh or sign-in; the
 * session starts anyway.
 */
export async function grantSessionGithubAccess(
  session: Record<string, unknown>,
  dependencies: SessionGithubAccessDependencies,
): Promise<{ notice?: string }> {
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return {};
  sessionGrants.delete(sessionId);
  if (!managedRuntimeSession(session) || typeof session.projectId !== "string")
    return {};
  const level = await dependencies
    .level(session.projectId)
    .catch((): AgentGithubAccessLevel => "off");
  if (level !== "read" && level !== "write") return {};
  const result = await dependencies.readToken();
  if ("unavailable" in result) return { notice: result.unavailable };
  sessionGrants.set(sessionId, { level, token: result.token });
  return {};
}

// Where lightWorkspace requests go to the managed runtime (Lima or WSL2).
function managedRuntimeSession(session: Record<string, unknown>) {
  const backend = session.backend;
  return (
    session.workspaceMode === "local-container" &&
    Boolean(backend) &&
    typeof backend === "object" &&
    (backend as Record<string, unknown>).mode === "remote"
  );
}

/**
 * The request with the credentials of its session, replacing any the agent
 * process sent. Without a token granted for writing they are empty, which
 * still keeps every inherited GitHub token away from the agent's commands.
 */
export function withSessionCommandCredentials(
  request: LightWorkspaceExecutionRequest,
): LightWorkspaceExecutionRequest {
  const sessionId =
    request.taskContract?.session_id ?? request.toolContext?.sessionId;
  const grant = sessionId ? sessionGrants.get(sessionId) : undefined;
  return {
    ...request,
    commandCredentials:
      grant?.level === "write" ? { githubToken: grant.token } : {},
  };
}

export const githubMcpUrl = "https://api.githubcopilot.com/mcp/";
export const githubMcpToolsets = "context,repos,issues,pull_requests,actions";

export type GithubMcpServer = { headers: Record<string, string>; url: string };

/**
 * GitHub's remote MCP server for a session with read-only access, with the
 * headers that carry its token; none for any other session.
 */
export function sessionGithubMcpServer(
  sessionId: string | undefined,
): GithubMcpServer | undefined {
  const grant = sessionId ? sessionGrants.get(sessionId) : undefined;
  if (grant?.level !== "read") return undefined;
  return {
    url: githubMcpUrl,
    headers: {
      Authorization: `Bearer ${grant.token}`,
      "X-MCP-Readonly": "true",
      "X-MCP-Toolsets": githubMcpToolsets,
    },
  };
}

/** Every token granted to a session, for log redaction. */
export function grantedGithubTokens() {
  return [...new Set([...sessionGrants.values()].map(({ token }) => token))];
}

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}

function validLevel(value: unknown): value is AgentGithubAccessLevel {
  return value === "off" || value === "read" || value === "write";
}
