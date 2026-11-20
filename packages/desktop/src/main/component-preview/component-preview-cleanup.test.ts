import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { excludeComponentPreviewFiles } from "../component-preview-exclude.ts";
import { removePreviewScratch } from "./component-preview-cleanup.ts";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd })).stdout;

test("a turn's end removes its temporary preview files and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-cleanup-"));
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await writeFile(join(root, "kept.blame-preview.tsx"), "tracked on purpose");
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
    ]);
    assert.equal(await excludeComponentPreviewFiles(root), true);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "card.blame-preview.tsx"), "export {}");
    await writeFile(join(root, "src", "list.blame-preview.ts"), "export {}");
    await writeFile(join(root, "dist", "build.blame-preview.js"), "built");
    await writeFile(
      join(root, "node_modules", "pkg", "x.blame-preview.js"),
      "dep",
    );
    // Git ignores the preview files from the start.
    assert.equal(await git(root, ["status", "--porcelain"]), "");

    assert.equal(await removePreviewScratch(git, root), 2);
    assert.deepEqual(await readdir(join(root, "src")), []);
    assert.deepEqual(await readdir(join(root, "dist")), [
      "build.blame-preview.js",
    ]);
    assert.deepEqual(await readdir(join(root, "node_modules", "pkg")), [
      "x.blame-preview.js",
    ]);
    assert.ok((await readdir(root)).includes("kept.blame-preview.tsx"));
    assert.equal(await removePreviewScratch(git, root), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
