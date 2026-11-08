import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { setupPath } from "../host-tool-path.ts";

// GitHub access for the agent, per project and off by default. When a Local
// Container session starts in a project that turned it on, the desktop reads
// `gh auth token` on this computer and keeps the token in memory for that
// session. Each of the session's managed runtime requests carries it, and the
// runtime gives it to the agent's commands as GH_TOKEN: it is never written
// to the worktree, Git configuration or an env file.

type SettingsFile = { projects?: string[] };

export class AgentGithubAccessSettings {
  private readonly file: string;
  private cache?: Promise<Set<string>>;

  constructor(file: string) {
    this.file = file;
  }

  async enabled(projectId: string | undefined) {
    if (!validProjectId(projectId)) return false;
    return (await this.projects()).has(projectId);
  }

  async setEnabled(projectId: string, enabled: boolean) {
    if (!validProjectId(projectId)) throw new Error("Invalid project id.");
    const projects = new Set(await this.projects());
    if (enabled) projects.add(projectId);
    else projects.delete(projectId);
    const content: SettingsFile = { projects: [...projects].sort() };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(content, null, 2));
    await rename(temporary, this.file);
    this.cache = Promise.resolve(projects);
    return enabled;
  }

  private projects() {
    this.cache ??= readFile(this.file, "utf8")
      .then((value) => {
        const parsed = JSON.parse(value) as SettingsFile;
        return new Set(
          (Array.isArray(parsed.projects) ? parsed.projects : []).filter(
            validProjectId,
          ),
        );
      })
      .catch(() => new Set<string>());
    return this.cache;
  }
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

// Session id -> the token granted when the session started.
const sessionTokens = new Map<string, string>();

export type SessionGithubAccessDependencies = {
  enabled(projectId: string): Promise<boolean>;
  readToken(): Promise<HostGithubToken>;
};

/**
 * Decides a session's GitHub access as it starts (or resumes): a Local
 * Container session in a project that turned it on gets the host's token.
 * The notice explains a missing gh or sign-in; the session starts anyway.
 */
export async function grantSessionGithubAccess(
  session: Record<string, unknown>,
  dependencies: SessionGithubAccessDependencies,
): Promise<{ notice?: string }> {
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return {};
  sessionTokens.delete(sessionId);
  if (!managedRuntimeSession(session) || typeof session.projectId !== "string")
    return {};
  const enabled = await dependencies
    .enabled(session.projectId)
    .catch(() => false);
  if (!enabled) return {};
  const result = await dependencies.readToken();
  if ("unavailable" in result) return { notice: result.unavailable };
  sessionTokens.set(sessionId, result.token);
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
 * process sent. Without a granted token they are empty, which still keeps
 * every inherited GitHub token away from the agent's commands.
 */
export function withSessionCommandCredentials(
  request: LightWorkspaceExecutionRequest,
): LightWorkspaceExecutionRequest {
  const sessionId =
    request.taskContract?.session_id ?? request.toolContext?.sessionId;
  const githubToken = sessionId ? sessionTokens.get(sessionId) : undefined;
  return { ...request, commandCredentials: githubToken ? { githubToken } : {} };
}

/** Every token granted to a session, for log redaction. */
export function grantedGithubTokens() {
  return [...new Set(sessionTokens.values())];
}

function validProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}
