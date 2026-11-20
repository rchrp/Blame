import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";

test("a new workspace restores an interrupted multi-file edit before reading", async () => {
  await fixture(async (root) => {
    await pendingWrite(root);
    await writeFile(join(root, "a.txt"), "new A");
    const workspace = new LightWorkspace(root, { sessionId: "recovery" });
    const result = await workspace.readCode(
      { target: "a.txt", view: "raw" },
      {},
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(JSON.stringify(result), /old A/u);
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), "old B");
    await assert.rejects(
      access(join(root, ".blame/harness/light-write/pending.json")),
    );
  });
});

test("recovery preserves a later external change instead of overwriting it", async () => {
  await fixture(async (root) => {
    await pendingWrite(root);
    await writeFile(join(root, "a.txt"), "external A");
    // Any operation takes the workspace's write turn, which recovers first.
    const result = await new LightWorkspace(root, { sessionId: "recovery" }).readCode({ target: "a.txt", view: "raw" }, {});
    assert.notEqual(result.status, "ok");
    assert.match(JSON.stringify(result), /newer change/u);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "external A");
    await access(join(root, ".blame/harness/light-write/pending.json"));
  });
});

// "harness readers wait until the whole batch is visible" paused a commit
// halfway by patching `WorkspaceFiles.resolveForWriteVerified` in process;
// a harness reached through its protocol has no such seam.

function mutations() {
  return ["A", "B"].map((label) => ({
    path: `${label.toLowerCase()}.txt`,
    before: Buffer.from(`old ${label}`),
    after: Buffer.from(`new ${label}`),
  }));
}

async function pendingWrite(root: string) {
  const directory = join(root, ".blame/harness/light-write");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "pending.json"),
    JSON.stringify(
      mutations().map((mutation) => ({
        ...mutation,
        before: mutation.before.toString("base64"),
        after: mutation.after.toString("base64"),
      })),
    ),
  );
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-recovery-"));
  try {
    await writeFile(join(root, "a.txt"), "old A");
    await writeFile(join(root, "b.txt"), "old B");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
