import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGeneratedJavaScript } from "./check-generated-javascript.mjs";

test("rejects a shim collision in a generated chunk before packaging", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-generated-js-"));
  try {
    await mkdir(join(root, "main/chunks"), { recursive: true });
    await mkdir(join(root, "preload"));
    await writeFile(join(root, "main/index.js"), 'await import("./chunks/devtools.js");');
    await writeFile(join(root, "preload/index.js"), 'const { contextBridge } = require("electron");');
    const chunk = join(root, "main/chunks/devtools.js");
    await writeFile(chunk, 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); var require = createRequire(import.meta.url);');
    await assert.rejects(checkGeneratedJavaScript(root), /devtools\.js:[\s\S]*Identifier 'require' has already been declared/);
    await writeFile(chunk, 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); var devtoolsRequire = createRequire(import.meta.url);');
    await checkGeneratedJavaScript(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
