import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  componentPreviewExcludePatterns,
  excludeComponentPreviewFiles,
  excludeFileContent,
  excludeScript,
} from "./component-preview-exclude.ts";

const run = promisify(execFile);

test("adds the patterns once, after the existing rules", () => {
  const next = excludeFileContent(
    "# git ls-files --others --exclude-from=.git/info/exclude\n*.log",
  );
  assert.equal(
    next,
    "# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n# Temporary component previews (Blame)\n*.blame-preview.*\nblame-preview/\n",
  );
  assert.equal(excludeFileContent(next!), undefined);
  assert.equal(
    excludeFileContent("blame-preview/\n"),
    "blame-preview/\n# Temporary component previews (Blame)\n*.blame-preview.*\n",
  );
});

test("hides temporary previews from git status in a linked worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-exclude-"));
  const repo = join(root, "repo");
  const worktree = join(root, "story");
  const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });
  try {
    await run("git", ["init", "-q", repo]);
    await writeFile(join(repo, "README.md"), "hello");
    await git(repo, "add", ".");
    await git(
      repo,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=n",
      "commit",
      "-qm",
      "init",
    );
    await git(repo, "worktree", "add", "-q", worktree);
    assert.equal(await excludeComponentPreviewFiles(worktree), true);
    assert.equal(await excludeComponentPreviewFiles(worktree), false);
    await writeFile(join(worktree, "dialog.blame-preview.html"), "<div></div>");
    await writeFile(join(worktree, "draft.ts"), "x");
    const { stdout } = await git(worktree, "status", "--porcelain");
    assert.equal(stdout.trim(), "?? draft.ts");
    const { stdout: path } = await git(
      worktree,
      "rev-parse",
      "--git-path",
      "info/exclude",
    );
    const content = await readFile(join(worktree, path.trim()), "utf8").catch(
      () => readFile(path.trim(), "utf8"),
    );
    assert.match(content, /\*\.blame-preview\.\*/);
    // Nothing is written to the tracked .gitignore.
    assert.equal((await git(worktree, "diff", "--stat")).stdout, "");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the runtime script adds the same lines once", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-exclude-sh-"));
  try {
    await run("git", ["init", "-q", root]);
    await writeFile(join(root, ".git/info/exclude"), "*.log");
    const apply = () =>
      run(
        "sh",
        ["-c", excludeScript(), "sh", ...componentPreviewExcludePatterns],
        {
          cwd: root,
        },
      );
    assert.equal((await apply()).stdout.trim(), "1");
    assert.equal((await apply()).stdout.trim(), "0");
    assert.equal(
      await readFile(join(root, ".git/info/exclude"), "utf8"),
      "*.log\n# Temporary component previews (Blame)\n*.blame-preview.*\nblame-preview/\n",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
