import { relative, sep } from "node:path";
import { execa } from "execa";
import { redactSecuritySecrets } from "../security-secret-redaction.js";
import { boundedDiagnostic } from "./light-diagnostic.js";
import type { FormattedFileReplacement } from "./light-edit.js";
import { workspaceCommandEnvironment } from "./workspace-command-environment.js";
import type { WorkspaceFiles } from "./workspace-files.js";

export type FormatterCommand = {
  args: string[];
  /** The directory of a leading `cd <dir> &&`, relative to the command's cwd. */
  cwd?: string;
  executable: string;
  paths: string[];
};

export class DeterministicFormatterError extends Error {
  readonly category: "code" | "environment" | "input";

  constructor(
    category: DeterministicFormatterError["category"],
    message: string,
  ) {
    super(message);
    this.category = category;
  }
}

export class DeterministicFormatter {
  private readonly files: WorkspaceFiles;

  constructor(files: WorkspaceFiles) {
    this.files = files;
  }

  request(command: string) {
    return formatterCommand(command);
  }

  recovery(command: string) {
    if (!/\bprettier\b[^\n]*\s--write(?:\s|$)/u.test(command)) return undefined;
    return "This request combines or ambiguously scopes Prettier. Submit `pnpm exec prettier --write <explicit existing files>` alone; for npm projects use `npx --no-install prettier --write <explicit existing files>` or `npm exec --no -- prettier --write <explicit existing files>`. It will be applied as one atomic journaled edit.";
  }

  async format(request: FormatterCommand, cwd: string, signal?: AbortSignal) {
    const paths = await this.resolvePaths(request.paths, cwd);
    const replacements: FormattedFileReplacement[] = [];
    for (const path of paths)
      replacements.push(await this.formatFile(request, path, cwd, signal));
    return replacements;
  }

  private async resolvePaths(paths: string[], cwd: string) {
    const localCwd = relative(this.files.root, cwd).split(sep).join("/");
    const normalized = paths.map((path) =>
      this.files.normalizePath(localCwd ? `${localCwd}/${path}` : path),
    );
    const unique = [...new Set(normalized)];
    if (unique.length !== paths.length)
      throw new DeterministicFormatterError(
        "input",
        "Formatter file paths must be unique.",
      );
    for (const path of unique) {
      const profile = await this.files.pathProfile(path).catch(() => undefined);
      if (!profile || profile.directory)
        throw new DeterministicFormatterError(
          "input",
          `Formatter target ${path} must be an existing regular file.`,
        );
      if (profile.size > 2_097_152)
        throw new DeterministicFormatterError(
          "input",
          `Formatter target ${path} exceeds the 2 MiB atomic edit limit.`,
        );
    }
    return unique;
  }

  private async formatFile(
    request: FormatterCommand,
    path: string,
    cwd: string,
    signal?: AbortSignal,
  ) {
    const absolute = this.files.resolveForWrite(path).absolute;
    const before = (await this.files.read(path)).content;
    const result = await runFormatter(request, absolute, before, cwd, signal);
    if (result.exitCode !== 0)
      throw new DeterministicFormatterError("code", formatterFailure(result));
    if (Buffer.byteLength(result.stdout) > 2_097_152)
      throw new DeterministicFormatterError(
        "code",
        `Formatted output for ${path} exceeds the 2 MiB atomic edit limit.`,
      );
    return { path, before, content: result.stdout };
  }
}

async function runFormatter(
  request: FormatterCommand,
  path: string,
  input: Buffer,
  cwd: string,
  signal?: AbortSignal,
) {
  // stdout becomes source text; package-manager progress must stay out of it.
  const args =
    request.executable === "pnpm"
      ? ["--reporter=silent", ...request.args]
      : request.args;
  return execa(
    request.executable,
    [...args, "--stdin-filepath", path],
    {
      cancelSignal: signal,
      cwd,
      env: workspaceCommandEnvironment(),
      extendEnv: false,
      input,
      reject: false,
      stripFinalNewline: false,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).catch((error) => {
    throw new DeterministicFormatterError("environment", errorMessage(error));
  });
}

function formatterFailure(result: {
  exitCode?: number;
  stderr: string;
  stdout: string;
}) {
  return (
    boundedDiagnostic(
      redactSecuritySecrets(`${result.stdout}\n${result.stderr}`),
    ).trim() || `Formatter exited with code ${result.exitCode}.`
  );
}

// `cd packages/app && pnpm exec prettier --write …` is the usual way to run a
// package's own formatter; the directory becomes the command's cwd.
const cdPrefix = /^\s*cd\s+([^\s;&|<>'"`$\\]+)\s*&&\s*/u;
// A trailing `2>&1 | tail -15` only trims what the agent would read; the
// harness reports the formatted files itself (US-045 lost a turn on it).
const displayFilter = /(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head)(?:\s+-n)?(?:\s+-?\d+)?)?\s*$/u;

function formatterCommand(command: string): FormatterCommand | undefined {
  const cd = cdPrefix.exec(command);
  const rest = (cd ? command.slice(cd[0].length) : command).replace(displayFilter, "");
  if (/[;&|<>\n\r'"`]/u.test(rest)) return undefined;
  const tokens = rest.trim().split(/\s+/u);
  const prefix = formatterPrefix(tokens);
  if (!prefix) return undefined;
  const values = tokens.slice(prefix.length);
  if (values.filter((value) => value === "--write").length !== 1)
    return undefined;
  const paths = values.filter((value) => value !== "--write");
  if (!paths.length || paths.length > 50 || paths.some(invalidPathToken))
    return undefined;
  return {
    executable: prefix.run[0]!,
    args: prefix.run.slice(1),
    ...(cd ? { cwd: cd[1]! } : {}),
    paths,
  };
}

function formatterPrefix(tokens: string[]) {
  const prefix = formatterPrefixes.find(
    (candidate) =>
      tokens.length > candidate.length &&
      candidate.every((value, index) => tokens[index] === value),
  );
  return prefix && { length: prefix.length, run: formatterRuns.get(prefix.join(" ")) ?? prefix };
}

function invalidPathToken(value: string) {
  return value.startsWith("-") || /[*?{}[\]]/u.test(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const formatterPrefixes = [
  ["npx", "--no-install", "prettier"],
  ["npx", "prettier"],
  ["npm", "exec", "--no", "--", "prettier"],
  ["pnpm", "exec", "prettier"],
  ["pnpm", "prettier"],
  ["yarn", "prettier"],
  ["node_modules/.bin/prettier"],
  ["./node_modules/.bin/prettier"],
  ["prettier"],
];

// The installed Prettier only: a formatter edit never downloads a package.
const formatterRuns = new Map([["npx prettier", ["npx", "--no-install", "prettier"]]]);
