// Temporary component previews never outlive a turn: when it ends, the
// preview files the conversation's worktrees hold are removed, then their
// servers stop (stopping a cloud preview's server also sends the removal to
// its sandbox). Tracked files are never touched, nor files the project
// itself ignores, such as a framework's build output: only untracked files
// matching the preview pattern, or ignored by that pattern alone.

import { componentPreviewExcludePatterns } from "../component-preview-exclude.ts";
import { run } from "../workspace-runtime.ts";

export type Git = (worktree: string, args: string[]) => Promise<string>;

// Git where the worktree is: this computer, or the runtime VM.
export const worktreeGit: Git = async (worktree, args) =>
  (await run("git", args, { cwd: worktree })).stdout;

const pathspecs = [
  ":(glob)**/*.blame-preview.*",
  ":(exclude,glob)**/node_modules/**",
];

/** Removes the worktree's temporary preview files; says how many, if any. */
export async function removePreviewScratch(git: Git, worktree: string) {
  const listed = (output: string) => output.split("\0").filter(Boolean);
  const [untracked, ignored] = await Promise.all([
    git(worktree, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ]).then(listed),
    git(worktree, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ]).then(listed),
  ]);
  const ours = ignored.length
    ? await ignoredByPreviewRules(git, worktree, ignored)
    : [];
  const files = [...new Set([...untracked, ...ours])];
  if (!files.length) return 0;
  for (let index = 0; index < files.length; index += 200)
    await git(worktree, [
      "clean",
      "-f",
      "-x",
      "--",
      ...files.slice(index, index + 200).map((file) => `:(literal)${file}`),
    ]);
  return files.length;
}

// Keeps the ignored files whose deciding rule is one of the preview patterns.
async function ignoredByPreviewRules(
  git: Git,
  worktree: string,
  files: string[],
) {
  const patterns: readonly string[] = componentPreviewExcludePatterns;
  const result: string[] = [];
  for (const file of files.slice(0, 500)) {
    const output = await git(worktree, [
      "check-ignore",
      "-v",
      "--",
      file,
    ]).catch(() => "");
    // source:line:pattern<TAB>path
    const pattern = output.match(/^.*:\d+:(.*)\t/u)?.[1];
    if (pattern && patterns.includes(pattern)) result.push(file);
  }
  return result;
}
