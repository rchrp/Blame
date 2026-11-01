import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hostGitCommand } from "../host-git.ts";

const execFileAsync = promisify(execFile);
const fileName = ".blameignore";
const excludePattern = "/.blameignore";
const heading =
  "# Cloud preview exclusions the project keeps out of Git (Blame)";

// The analysis writes the cloud exclusions to the project's checkout without
// committing them, while a story worktree only holds what is committed: its
// cloud preview would send everything they exclude. Before a cloud sync, a
// story that does not track its own .blameignore gets the project's, kept
// out of its diff by .git/info/exclude like Blame's other files.
export async function syncProjectCloudIgnore(worktree: string) {
  const git = async (cwd: string, args: string[]) =>
    (await execFileAsync(hostGitCommand(), args, { cwd })).stdout.trim();
  const tracked = await git(worktree, ["ls-files", "--", fileName]).catch(
    () => "",
  );
  if (tracked) return false;
  const common = await git(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).catch(() => "");
  if (basename(common) !== ".git") return false;
  const project = dirname(common);
  if (resolve(project) === resolve(worktree)) return false;
  const rules = await readFile(join(project, fileName), "utf8").catch(
    () => undefined,
  );
  if (rules === undefined) return false;
  const current = await readFile(join(worktree, fileName), "utf8").catch(
    () => undefined,
  );
  if (current === rules) return false;
  await writeFile(join(worktree, fileName), rules);
  const excludePath = await git(worktree, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  const exclude = isAbsolute(excludePath)
    ? excludePath
    : resolve(worktree, excludePath);
  const content = await readFile(exclude, "utf8").catch(() => "");
  if (!content.split(/\r?\n/u).some((line) => line.trim() === excludePattern)) {
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    await mkdir(dirname(exclude), { recursive: true });
    await writeFile(
      exclude,
      `${content}${separator}${heading}\n${excludePattern}\n`,
    );
  }
  return true;
}
