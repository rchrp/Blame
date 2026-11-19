import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Runs agent-browser, the native CLI that drives the agent's preview page.
// Each scope gets a session: a small daemon that agent-browser starts on
// the first command and that keeps one CDP connection to the scope's proxy.
// It never launches or downloads a browser: every command names the proxy
// endpoint, and the daemon only attaches to it. Its home, configuration and
// sockets live in a directory of Blame's, so a user's own agent-browser
// configuration, profiles or plugins never apply.

export type AgentBrowserRun = {
  args: string[];
  // The scope's proxy endpoint. It carries the proxy token: it goes
  // through the environment, never the command line.
  endpoint?: string;
  session: string;
  signal?: AbortSignal;
  // agent-browser's own limit for waits; the process is killed a little
  // later, so its message comes first.
  timeoutMs: number;
};

export class AgentBrowserError extends Error {
  // The command never answered: its session may still be stuck on it.
  readonly unanswered: boolean;
  constructor(
    message: string,
    options: { cause?: unknown; unanswered?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.unanswered = options.unanswered === true;
  }
}

const outputLimitBytes = 64 * 1024 * 1024;
const killMarginMs = 3_000;
// The daemon outlives a quiet run: the browser it attaches to stays open up
// to an hour while a run holds it (agent-preview-browser). Blame closes the
// session itself; this only bounds a daemon left behind by a crash.
const daemonIdleTimeoutMs = 65 * 60_000;
// Keep this binding distinct from electron-vite's generated CommonJS shim.
const cliRequire = createRequire(import.meta.url);
let home: string | undefined;

export function configureAgentBrowserHome(directory: string) {
  home = directory;
}

// One session per connection, so a closing session never races the one
// that replaces it. Its socket path must stay under 104 bytes.
export function agentBrowserSession(scope: string) {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 10);
  return `b-${hash}-${randomBytes(3).toString("hex")}`;
}

export async function runAgentBrowser(input: AgentBrowserRun) {
  input.signal?.throwIfAborted();
  const environment = await agentBrowserEnvironment(input);
  try {
    return await runCommand(input, environment);
  } finally {
    // agent-browser keeps a file per session next to its socket, even once
    // closed; sessions are never reused.
    if (input.args[0] === "close")
      await removeSessionFiles(
        environment.AGENT_BROWSER_SOCKET_DIR!,
        input.session,
      );
  }
}

async function removeSessionFiles(sockets: string, session: string) {
  const files = await readdir(sockets).catch(() => []);
  await Promise.all(
    files
      .filter((name) => name.startsWith(`${session}.`))
      .map((name) => rm(join(sockets, name), { force: true })),
  );
}

async function runCommand(
  input: AgentBrowserRun,
  environment: Record<string, string>,
) {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      agentBrowserExecutable(),
      [...input.args, "--json"],
      {
        cwd: environment.HOME,
        env: environment,
        maxBuffer: outputLimitBytes,
        signal: input.signal,
        timeout: input.timeoutMs + killMarginMs,
        windowsHide: true,
      },
      (error, out) => {
        // A failed command still prints its JSON answer.
        if (out.trim()) return resolve(out);
        if (!error) return resolve(out);
        reject(
          new AgentBrowserError(
            child.killed && !input.signal?.aborted
              ? `agent-browser did not answer within ${Math.round((input.timeoutMs + killMarginMs) / 1000)} s.`
              : `agent-browser failed: ${error.message}`,
            {
              cause: error,
              unanswered: child.killed && !input.signal?.aborted,
            },
          ),
        );
      },
    );
  });
  return parseAnswer(stdout);
}

function parseAnswer(stdout: string) {
  let answer: { data?: unknown; error?: unknown; success?: unknown };
  try {
    answer = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch (error) {
    throw new AgentBrowserError(
      "agent-browser returned an unreadable answer.",
      {
        cause: error,
      },
    );
  }
  if (answer.success !== true)
    throw new AgentBrowserError(
      typeof answer.error === "string" && answer.error
        ? answer.error
        : "agent-browser reported a failure.",
    );
  const data = answer.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

async function agentBrowserEnvironment(input: AgentBrowserRun) {
  if (!home) throw new AgentBrowserError("agent-browser is not configured.");
  // The per-user temporary directory keeps socket paths short; the
  // directory is private to the user.
  const sockets = join(tmpdir(), `blame-ab-${process.getuid?.() ?? "user"}`);
  await mkdir(sockets, { mode: 0o700, recursive: true });
  await mkdir(home, { recursive: true });
  // Nothing of the user's environment: no AGENT_BROWSER_* override, proxy
  // or token reaches the daemon.
  return Object.fromEntries(
    Object.entries({
      AGENT_BROWSER_CDP: input.endpoint || undefined,
      AGENT_BROWSER_DEFAULT_TIMEOUT: String(input.timeoutMs),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: String(daemonIdleTimeoutMs),
      AGENT_BROWSER_NO_VERSION_CHECK: "1",
      AGENT_BROWSER_SESSION: input.session,
      AGENT_BROWSER_SOCKET_DIR: sockets,
      HOME: home,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      USERPROFILE: home,
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

let executable: string | undefined;

export function agentBrowserExecutable() {
  if (executable) return executable;
  const name = platformPackage();
  if (!name)
    throw new AgentBrowserError(
      `The agent browser is not available on ${process.platform}-${process.arch}.`,
    );
  const binary = join(
    dirname(cliRequire.resolve(`${name}/package.json`)),
    "bin",
    process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
  );
  // A packaged app runs it from the unpacked copy of the archive.
  const unpacked = binary.replace(/app\.asar(?=[/\\])/u, "app.asar.unpacked");
  executable = existsSync(unpacked) ? unpacked : binary;
  return executable;
}

function platformPackage() {
  const platform = `${process.platform}-${process.arch}`;
  const packages: Record<string, string> = {
    "darwin-arm64": "@agent-browser/cli-darwin-arm64",
    "darwin-x64": "@agent-browser/cli-darwin-x64",
    "linux-arm64": "@agent-browser/cli-linux-arm64-gnu",
    "linux-x64": "@agent-browser/cli-linux-x64-gnu",
    "win32-arm64": "@agent-browser/cli-win32-x64-msvc",
    "win32-x64": "@agent-browser/cli-win32-x64-msvc",
  };
  return packages[platform];
}
