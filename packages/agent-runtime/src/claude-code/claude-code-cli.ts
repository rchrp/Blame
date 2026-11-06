import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import type { ClaudeCodeStatus } from "../types.js";
import { bridgeMcpServerName, type ClaudeCodeEffort } from "./claude-code-protocol.js";

const execFileAsync = promisify(execFile);


/** Variables that would make Claude Code bill an API key instead of the subscription. */
const apiKeyEnvironment = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function findClaudeCodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const configured = env.BLAME_CLAUDE_CODE_PATH?.trim();
  if (configured) return executable(configured) ? configured : undefined;
  // npm's claude.cmd shim cannot be spawned without a shell; the native
  // installer ships claude.exe.
  const names = platform === "win32" ? ["claude.exe"] : ["claude"];
  const home = homedir();
  const directories = [
    ...(env.PATH ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    ...(platform === "win32"
      ? [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm")]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          join(home, ".npm-global", "bin"),
          join(home, ".bun", "bin"),
        ]),
  ];
  for (const directory of directories) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function readClaudeCodeStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeStatus> {
  const executablePath = findClaudeCodeExecutable(env);
  if (!executablePath) return { installed: false, loggedIn: false };
  const childEnv = claudeCodeEnvironment(env);
  try {
    const [version, auth] = await Promise.all([
      execFileAsync(executablePath, ["--version"], {
        env: childEnv,
        timeout: 15_000,
      }),
      execFileAsync(executablePath, ["auth", "status", "--json"], {
        env: childEnv,
        timeout: 15_000,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" })),
    ]);
    const status = parseAuthStatus(auth.stdout);
    return {
      installed: true,
      executablePath,
      version: version.stdout.trim().split(/\s+/)[0],
      ...status,
    };
  } catch (error) {
    return {
      installed: true,
      executablePath,
      loggedIn: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseAuthStatus(stdout: string) {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: value.loggedIn === true,
      authMethod: stringValue(value.authMethod),
      email: stringValue(value.email),
      subscriptionType: stringValue(value.subscriptionType),
    };
  } catch {
    return { loggedIn: false };
  }
}

export function claudeCodeEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of apiKeyEnvironment) delete next[key];
  // Blame's tools can wait on approvals or long commands, and they already
  // bound their own output.
  next.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1_000);
  // Without it, Claude Code drops a tool call silent for 300 s (the bridge's
  // pings do not count) and answers on its own: one more model call per
  // finished US, and a lost lane.
  next.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = "0";
  next.MAX_MCP_OUTPUT_TOKENS = "200000";
  // Claude Code may start its first turn before Blame's MCP server answers;
  // as the host, wait for it (the bridge also holds the first message until
  // the tools are listed).
  next.CLAUDE_CODE_MCP_STARTUP_WAIT_MS = "20000";
  next.DISABLE_AUTOUPDATER = "1";
  return next;
}

export function claudeCodeArguments(input: {
  effort?: ClaudeCodeEffort;
  /** Blame's MCP endpoint; left out when the request offers no tools. */
  mcpUrl?: string;
  model: string;
  systemPromptFile: string;
}) {
  const mcpServers = input.mcpUrl
    ? { [bridgeMcpServerName]: { type: "http", url: input.mcpUrl } }
    : {};
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Claude Code acts as the model only: Blame's harness owns every tool.
    "--tools",
    "",
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--strict-mcp-config",
    ...(input.mcpUrl ? ["--allowedTools", `mcp__${bridgeMcpServerName}`] : []),
    "--permission-prompts",
    "none",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file",
    input.systemPromptFile,
    "--model",
    input.model,
    ...(input.effort ? ["--effort", input.effort] : []),
  ];
}

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
