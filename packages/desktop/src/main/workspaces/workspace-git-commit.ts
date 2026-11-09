import { runRuntimeGit } from "../workspace-runtime-git.ts";

// What the person staged for other files stays staged: `--only` commits the
// working-tree content of the given files and leaves the index of the rest.
export async function gitCommitFiles(
  cwd: string,
  message: string,
  paths: string[],
) {
  const files = paths.map(literalPathspec);
  // A path commit only knows files Git already tracks or was told about.
  const untracked = await gitUntrackedFiles(cwd, files);
  if (untracked.length > 0)
    await runRuntimeGit(cwd, ["add", "--intent-to-add", "--", ...untracked]);
  try {
    const result = await runRuntimeGit(cwd, [
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
      "--only",
      "--",
      ...files,
    ]);
    return { output: result.stdout || result.stderr };
  } catch (error) {
    if (untracked.length > 0)
      await runRuntimeGit(cwd, [
        "rm",
        "--cached",
        "--quiet",
        "--ignore-unmatch",
        "--",
        ...untracked,
      ]).catch(() => undefined);
    throw error;
  }
}

async function gitUntrackedFiles(cwd: string, files: string[]) {
  const { stdout } = await runRuntimeGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...files,
  ]);
  return stdout.split("\0").filter(Boolean).map(literalPathspec);
}

function literalPathspec(path: string) {
  return `:(literal)${path}`;
}
