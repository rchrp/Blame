import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";

test("an explicit single-file update header selects its target", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "first.txt",
      patch: envelope("*** Update File: second.txt\n@@\n-original\n+updated") }] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "updated\n");
  });
});

test("an explicit delete header cannot be redirected by the outer path", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "first.txt",
      patch: envelope("*** Delete File: second.txt") }] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
    await assert.rejects(access(join(root, "second.txt")));
  });
});

test("an explicit add header selects its target even when the outer path exists", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "first.txt",
      patch: envelope("*** Add File: third.txt\n+created\n+") }] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
    assert.equal(await readFile(join(root, "third.txt"), "utf8"), "created\n");
  });
});

test("headerless hunks still use the supplied path", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "first.txt",
      patch: envelope("@@\n-original\n+updated") }] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "updated\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "original\n");
  });
});

test("file headers remain subject to workspace boundaries", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch", path: "first.txt",
      patch: envelope("*** Add File: ../escaped.txt\n+outside") }] }, {});
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
  });
});

test("delete then add replaces an observed file atomically", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch",
      patch: envelope("*** Delete File: first.txt\n*** Add File: first.txt\n+replacement\n+") }] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "replacement\n");
  });
});

test("replacement does not hide an overlapping edit elsewhere in the batch", async () => {
  await fixture(async (root, workspace) => {
    const result = await workspace.editCode({ operations: [{ kind: "patch",
      patch: envelope("*** Update File: first.txt\n@@\n-original\n+updated\n*** Delete File: first.txt\n*** Add File: first.txt\n+replacement") }] }, {});
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
  });
});

test("delete then add preserves the original when replacement syntax is invalid", async () => {
  await fixture(async (root, workspace) => {
    await writeFile(join(root, "module.py"), "def value():\n    return 1\n");
    await workspace.readCode({ target: "module.py" }, {});
    const result = await workspace.editCode({ operations: [{ kind: "patch",
      patch: envelope("*** Delete File: module.py\n*** Add File: module.py\n+def value():\n+    ???\n+") }] }, {});
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(await readFile(join(root, "module.py"), "utf8"), "def value():\n    return 1\n");
  });
});

function envelope(body: string) {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

async function fixture(run: (root: string, workspace: LightWorkspace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-patch-targets-"));
  try {
    await writeFile(join(root, "first.txt"), "original\n");
    await writeFile(join(root, "second.txt"), "original\n");
    const workspace = new LightWorkspace(root, { sessionId: "patch-targets" });
    await workspace.readCode({ target: "first.txt" }, {});
    await workspace.readCode({ target: "second.txt" }, {});
    await run(root, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
