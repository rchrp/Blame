import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withoutTelemetryEnvironment } from "@blame/telemetry";
import { hostGitCommand } from "./host-git.ts";

// The name and email Git signs commits with. Without them commits fail
// ("Author identity unknown"), so Blame asks for them before a story starts
// and saves them in the person's global Git settings.

export type GitIdentity = {
  // False when Git cannot run here at all: the host checks report that.
  available: boolean;
  configured: boolean;
  email: string;
  name: string;
};

export type GitIdentityInput = { email: string; name: string };

type GitRunner = (args: string[], cwd?: string) => Promise<string>;

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 15_000;
// Blame's runtime once wrote this when nothing was set: not a real address.
const placeholderEmails = new Set(["blame@example.local"]);

export async function readGitIdentity(
  input: { root?: string } = {},
  git: GitRunner = runGit,
): Promise<GitIdentity> {
  try {
    await git(["--version"]);
  } catch {
    return { available: false, configured: false, email: "", name: "" };
  }
  const [name, email] = await Promise.all([
    configValue(git, "user.name", input.root),
    configValue(git, "user.email", input.root),
  ]);
  return {
    available: true,
    configured:
      Boolean(name) && Boolean(email) && !placeholderEmails.has(email),
    email: placeholderEmails.has(email) ? "" : email,
    name,
  };
}

export async function saveGitIdentity(
  input: GitIdentityInput,
  git: GitRunner = runGit,
) {
  const identity = validGitIdentity(input);
  await git(["config", "--global", "user.name", identity.name]);
  await git(["config", "--global", "user.email", identity.email]);
  return identity;
}

export function validGitIdentity(input: GitIdentityInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  // Git refuses angle brackets and line breaks in an identity.
  if (!name || name.length > 200 || /[<>\r\n]/.test(name))
    throw new Error("Enter your name, without < or >.");
  if (
    email.length > 254 ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(email) ||
    placeholderEmails.has(email)
  )
    throw new Error("Enter a valid email address.");
  return { email, name };
}

// Unset reads as "" (git exits 1); anything else is a real failure.
async function configValue(git: GitRunner, key: string, root?: string) {
  try {
    return (await git(["config", "--get", key], root)).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return "";
    throw error;
  }
}

async function runGit(args: string[], cwd?: string) {
  const env = withoutTelemetryEnvironment(process.env);
  const { stdout } = await execFileAsync(hostGitCommand({ env }), args, {
    ...(cwd ? { cwd } : {}),
    env,
    timeout: commandTimeoutMs,
  });
  return stdout;
}
