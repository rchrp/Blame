import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { hostGitCommand } from "./host-git.ts";
import {
  run as runInWorkspace,
  runtimeManagedPath,
} from "./workspace-runtime.ts";

// Temporary component previews are named so Git ignores them. They go in
// .git/info/exclude, never in .gitignore, so the story's diff stays clean.

export const componentPreviewExcludePatterns = [
  "*.blame-preview.*",
  "blame-preview/",
] as const;

const execFileAsync = promisify(execFile);
const heading = "# Temporary component previews (Blame)";

export function excludeFileContent(current: string) {
  const lines = new Set(current.split(/\r?\n/u).map((line) => line.trim()));
  const missing = componentPreviewExcludePatterns.filter(
    (pattern) => !lines.has(pattern),
  );
  if (!missing.length) return undefined;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  return `${current}${separator}${heading}\n${missing.join("\n")}\n`;
}

export async function excludeComponentPreviewFiles(worktree: string) {
  if (runtimeManagedPath(worktree)) return excludeInRuntime(worktree);
  const { stdout } = await execFileAsync(
    hostGitCommand(),
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: worktree },
  );
  const relativePath = stdout.trim();
  if (!relativePath) throw new Error("Git did not report an exclude file.");
  const file = isAbsolute(relativePath)
    ? relativePath
    : resolve(worktree, relativePath);
  const current = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const next = excludeFileContent(current);
  if (next === undefined) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
  return true;
}

// The same, inside the managed runtime where the worktree lives.
async function excludeInRuntime(worktree: string) {
  const { stdout } = await runInWorkspace(
    "sh",
    ["-c", excludeScript(), "sh", ...componentPreviewExcludePatterns],
    { cwd: worktree },
  );
  return stdout.trim() === "1";
}

export function excludeScript() {
  return [
    "file=$(git rev-parse --git-path info/exclude) || exit 1",
    'mkdir -p "$(dirname "$file")" && touch "$file"',
    "changed=0",
    'for pattern in "$@"; do',
    '  if ! grep -qxF "$pattern" "$file"; then',
    '    if [ "$changed" = 0 ]; then',
    '      if [ -s "$file" ] && [ -n "$(tail -c1 "$file")" ]; then printf "\\n" >> "$file"; fi',
    `      printf "%s\\n" "${heading}" >> "$file"`,
    "      changed=1",
    "    fi",
    '    printf "%s\\n" "$pattern" >> "$file"',
    "  fi",
    "done",
    'echo "$changed"',
  ].join("\n");
}
