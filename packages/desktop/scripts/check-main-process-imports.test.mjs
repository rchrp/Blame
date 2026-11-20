import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkMainProcessImports } from "./check-main-process-imports.mjs";

test("the main process may load the runtime's light entries, never its engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-main-imports-"));
  const write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const runtime = "node_modules/@blame/agent-runtime";
  try {
    await write(
      `${runtime}/package.json`,
      JSON.stringify({
        name: "@blame/agent-runtime",
        type: "module",
        exports: {
          ".": "./dist/index.js",
          "./light": "./dist/light.js",
          "./backed": "./dist/backed.js",
        },
      }),
    );
    await write(`${runtime}/dist/index.js`, 'export * from "./engine.js";');
    await write(
      `${runtime}/dist/engine.js`,
      'import { Client as Agent } from "@modelcontextprotocol/sdk"; export { Agent };',
    );
    await write(
      `${runtime}/dist/light.js`,
      'import ipaddr from "ipaddr.js"; export { ipaddr };',
    );
    await write(
      `${runtime}/dist/backed.js`,
      'export { Agent } from "./engine.js";',
    );
    await write(
      "out/main/index.js",
      'import "node:path"; import "electron"; await import("./chunks/lazy.js");',
    );
    const chunk = (source) => write("out/main/chunks/lazy.js", source);
    const output = join(root, "out");

    await chunk('import { ipaddr } from "@blame/agent-runtime/light";');
    assert.equal(await checkMainProcessImports(output), 3);

    await chunk('await import("@blame/agent-runtime");');
    await assert.rejects(
      checkMainProcessImports(output),
      /lazy\.js imports @blame\/agent-runtime, the agent runtime's whole engine/,
    );

    await chunk('export { Agent } from "@blame/agent-runtime/backed";');
    await assert.rejects(
      checkMainProcessImports(output),
      /engine\.js imports @modelcontextprotocol\/sdk, a dependency of the agent engine/,
    );

    await chunk("const name = 'x'; await import(name);");
    await assert.rejects(
      checkMainProcessImports(output),
      /lazy\.js imports a computed module path/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
