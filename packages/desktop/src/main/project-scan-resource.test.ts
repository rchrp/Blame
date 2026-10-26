import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectScanResource } from "./project-scan-resource.ts";
import { projectScanRoot } from "./runtime-workspace-mirror.ts";

const workspace =
  "/home/blame/.local/share/blame/runtime/worktrees/app/story-1";

test("releasing a WSL scan across IPC never deletes the original UNC worktree", async () => {
  const location = await projectScanRoot(workspace, "win32");
  assert.notEqual(location.root, workspace);
  assert.match(location.root, /^\\\\wsl\.localhost\\/);
  assert.equal(location.temporary, false);
  // Serialize exactly the metadata that crosses the host/agent boundary.
  const response = JSON.parse(JSON.stringify(location));
  let removals = 0;
  await projectScanResource(response, async () => {
    removals++;
  }).release();
  assert.equal(removals, 0);
});

test("releasing a native scan preserves the project's files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blame-scan-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "uncommitted.txt"), "keep me");
  const location = await projectScanRoot(root);
  await projectScanResource(JSON.parse(JSON.stringify(location))).release();
  assert.equal(
    await readFile(join(root, "uncommitted.txt"), "utf8"),
    "keep me",
  );
});

test("macOS mirrors are still cleaned after a scan without touching the source", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "blame-scan-mirror-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "project.txt");
  await writeFile(source, "keep me");
  const location = await projectScanRoot(workspace, "darwin", {
    homedir: () => home,
    run: async (_command, args) => {
      await writeFile(join(args[4]!, "project.txt"), await readFile(source));
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(location.temporary, true);
  assert.equal(
    await readFile(join(location.root, "project.txt"), "utf8"),
    "keep me",
  );
  await projectScanResource(JSON.parse(JSON.stringify(location))).release();
  await assert.rejects(readFile(join(location.root, "project.txt")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(source, "utf8"), "keep me");
});

test("a failed macOS copy only removes its allocated mirror", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "blame-scan-failed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "project");
  await mkdir(source);
  await writeFile(join(source, "uncommitted.txt"), "keep me");
  await assert.rejects(
    projectScanRoot(workspace, "darwin", {
      homedir: () => home,
      run: async () => {
        throw new Error("copy failed");
      },
    }),
    /copy failed/,
  );
  assert.deepEqual(
    await readdir(join(home, "Library", "Caches", "Blame", "scan-mirrors")),
    [],
  );
  assert.equal(
    await readFile(join(source, "uncommitted.txt"), "utf8"),
    "keep me",
  );
});
