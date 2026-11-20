import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  finishComponentPreviews,
  removePreviewScratch,
} from "./cline-runtime-tools.js";
import type { ComponentPreviewHostInput } from "./engine/tools/preview-types.js";

const run = promisify(execFile);

function fakeDesktop(result: (input: ComponentPreviewHostInput) => unknown) {
  const calls: ComponentPreviewHostInput[] = [];
  return {
    calls,
    options: {
      componentPreview: async (input: ComponentPreviewHostInput) => {
        calls.push(input);
        return result(input);
      },
    },
  };
}

test("finishing removes the preview files, then stops the preview server", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-finish-"));
  const git = async (cwd: string, args: string[]) =>
    (await run("git", args, { cwd })).stdout;
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "card.blame-preview.tsx"), "export {}");
    // A cloud preview's sandbox gets the removal when its server stops.
    const atStop: string[][] = [];
    const desktop = fakeDesktop(async () => {
      atStop.push(await readdir(root));
      return { stopped: 1 };
    });
    const note = await finishComponentPreviews(
      { ...desktop.options, git },
      root,
      "preview-session",
    );
    assert.deepEqual(desktop.calls, [
      { action: "stop", sessionId: "preview-session", worktree: root },
    ]);
    assert.deepEqual(atStop, [[".git"]]);
    assert.equal(note, "Removed 1 temporary preview file.");
    assert.deepEqual(await readdir(root), [".git"]);
    const failing = await finishComponentPreviews(
      {
        componentPreview: async () => {
          throw new Error("runtime unreachable");
        },
        git,
      },
      root,
      "preview-session",
    );
    assert.equal(
      failing,
      "The component preview server did not stop: runtime unreachable",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("finishing removes temporary preview files and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-scratch-"));
  const git = async (cwd: string, args: string[]) =>
    (await run("git", args, { cwd })).stdout;
  try {
    await git(root, ["init", "-q"]);
    await mkdir(join(root, "packages/app/src"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "keep.ts"), "keep");
    await writeFile(join(root, "tracked.blame-preview.md"), "tracked");
    await git(root, ["add", "keep.ts", "tracked.blame-preview.md"]);
    await git(root, [
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=n",
      "commit",
      "-qm",
      "init",
    ]);
    await writeFile(join(root, "settings.blame-preview.tsx"), "export {}");
    await writeFile(
      join(root, "packages/app/src/dialog.blame-preview.tsx"),
      "export {}",
    );
    await writeFile(join(root, "packages/app/src/dialog.tsx"), "draft");
    await writeFile(join(root, "node_modules/pkg/x.blame-preview.js"), "");
    await writeFile(join(root, "draft.ts"), "untracked");
    // The project ignores its build output; a build of the preview stays.
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/card.blame-preview.js"), "");
    await writeFile(join(root, ".git/info/exclude"), "*.blame-preview.*\n");
    await writeFile(join(root, "card.blame-preview.tsx"), "export {}");
    assert.equal(
      await removePreviewScratch(git, root),
      "Removed 3 temporary preview files.",
    );
    assert.deepEqual(await readdir(join(root, "dist")), [
      "card.blame-preview.js",
    ]);
    assert.deepEqual((await readdir(root)).sort(), [
      ".git",
      ".gitignore",
      "dist",
      "draft.ts",
      "keep.ts",
      "node_modules",
      "packages",
      "tracked.blame-preview.md",
    ]);
    assert.deepEqual(await readdir(join(root, "packages/app/src")), [
      "dialog.tsx",
    ]);
    assert.deepEqual(await readdir(join(root, "node_modules/pkg")), [
      "x.blame-preview.js",
    ]);
    assert.equal(await removePreviewScratch(git, root), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
