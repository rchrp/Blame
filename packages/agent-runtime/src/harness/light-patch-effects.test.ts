import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";

test("removing one identical call has one file result despite several positions", async () => {
  const source = "prepare();\nwork();\nwork();\nwork();\nfinish();\n";
  await fixture("module.ts", source, async (root, workspace) => {
    const result = await workspace.editCode({ operations: [patch("module.ts", "-work();")] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "module.ts"), "utf8"),
      "prepare();\nwork();\nwork();\nfinish();\n");
  });
});

test("growing a repeated data block preserves its surrounding records", async () => {
  await fixture("rows.txt", "header\nrow\nrow\nrow\nfooter\n", async (root, workspace) => {
    const result = await workspace.editCode({ operations: [patch("rows.txt", "-row\n-row\n+row\n+row\n+row")] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "rows.txt"), "utf8"),
      "header\nrow\nrow\nrow\nrow\nfooter\n");
  });
});

test("equivalent repeated edits preserve Unicode and CRLF", async () => {
  await fixture("rows.txt", "début\r\nété\r\nété\r\nété\r\nfin\r\n", async (root, workspace) => {
    const result = await workspace.editCode({ operations: [patch("rows.txt", "-été\n-été\n+été")] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "rows.txt"), "utf8"), "début\r\nété\r\nété\r\nfin\r\n");
  });
});

test("a distant third occurrence prevents accepting two locally equivalent matches", async () => {
  const source = "work();\nwork();\ndivider();\nwork();\n";
  await fixture("module.ts", source, async (root, workspace) => {
    const result = await workspace.editCode({ operations: [patch("module.ts", "-work();")] }, {});
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "module.ts"), "utf8"), source);
  });
});

test("changing a repeated value still requires a unique target", async () => {
  const source = "work();\nwork();\nwork();\n";
  await fixture("module.ts", source, async (root, workspace) => {
    const result = await workspace.editCode({ operations: [patch("module.ts", "-work();\n+finish();")] }, {});
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "module.ts"), "utf8"), source);
  });
});

test("equivalent edits remain atomic with an invalid change elsewhere", async () => {
  const source = "work();\nwork();\nwork();\n";
  await fixture("module.ts", source, async (root, workspace) => {
    await writeFile(join(root, "other.ts"), "export const value = 1;\n");
    await workspace.readCode({ target: "other.ts" }, {});
    const result = await workspace.editCode({ operations: [patch("module.ts", "-work();"),
      patch("other.ts", "-export const value = 1;\n+export const value = ;")] }, {});
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "module.ts"), "utf8"), source);
    assert.equal(await readFile(join(root, "other.ts"), "utf8"), "export const value = 1;\n");
  });
});

test("an unchanged ambiguous hunk does not block a uniquely located change", async () => {
  await fixture("module.ts", "work();\nwork();\nfinish();\n", async (root, workspace) => {
    const body = "-work();\n+work();\n@@\n-finish();\n+done();";
    const result = await workspace.editCode({ operations: [patch("module.ts", body)] }, {});
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(await readFile(join(root, "module.ts"), "utf8"), "work();\nwork();\ndone();\n");
  });
});

test("an unchanged hunk cannot hide ambiguous placement of a later change", async () => {
  const source = "work();\nwork();\nwork();\n";
  await fixture("module.ts", source, async (root, workspace) => {
    const body = "-work();\n+work();\n@@\n-work();\n+done();";
    const result = await workspace.editCode({ operations: [patch("module.ts", body)] }, {});
    assert.equal(result.status, "blocked");
    assert.equal(await readFile(join(root, "module.ts"), "utf8"), source);
  });
});

function patch(path: string, body: string) {
  return { kind: "patch" as const, path,
    patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n${body}\n*** End Patch` };
}

async function fixture(path: string, source: string,
  run: (root: string, workspace: LightWorkspace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "blame-patch-effects-"));
  try {
    await writeFile(join(root, path), source);
    const workspace = new LightWorkspace(root, { sessionId: "patch-effects" });
    await workspace.readCode({ target: path }, {});
    await run(root, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
