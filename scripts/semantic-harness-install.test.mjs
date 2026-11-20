import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildSemanticHarnessPayload } from "./semantic-harness-payload.mjs";

const execute = promisify(execFile);

// The runtime VM installs the payload with `npm install -g`; its engine's
// launcher finds the package through the command and runs blame-harness
// with it (packages/desktop/src/main/engine/vm-engine.ts).
const harnessBinary = process.env.BLAME_HARNESS_BIN ??
  join(import.meta.dirname, "..", "target/debug", process.platform === "win32" ? "blame-harness.exe" : "blame-harness");

test("a fresh npm installation serves blame-harness's Node side", { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-npm-smoke-"));
  try {
    const archive = join(directory, "runtime.tgz");
    await buildSemanticHarnessPayload({ outputPaths: [archive], runtimeVersion: "npm-test" });
    await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--global", "--prefix", directory, "--no-audit", "--no-fund", archive],
      { shell: process.platform === "win32", timeout: 240000, maxBuffer: 1024 * 1024 });
    const packageRoot = join(directory, process.platform === "win32" ? "node_modules" : "lib/node_modules", "@blame/semantic-harness-runtime");
    // The command is the compiler side process: ready, then it exits when its input closes.
    const compiler = join(packageRoot, "harness/rust-harness-compiler.js");
    const { stdout: ready } = await execute(process.execPath, [compiler], { timeout: 30000 });
    assert.match(ready, /"ready":true/u);
    for (const [name, version] of [["pnpm", "12.15.0"], ["pnpm-legacy", "10.34.9"], ["npm", "12.2.1"], ["npm-legacy", "11.6.4"], ["yarn", "1.22.22"]]) {
      const manifest = JSON.parse(await readFile(join(packageRoot, "node_modules", name, "package.json"), "utf8"));
      assert.equal(manifest.version, version, name);
    }
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "package.json"), '{"scripts":{}}');
    await writeFile(join(workspace, "a.ts"), "export const a: number = 1;\n");
    const input = JSON.stringify({ tool: "edit_code", input: { operations: [{ kind: "patch", path: "a.ts",
      patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-export const a: number = 1;\n+export const a: number = \"x\";\n*** End Patch" }] },
      taskContract: { session_id: "npm-install-test" }, workspaceRoot: workspace });
    const { stdout } = await new Promise((resolve, reject) => {
      const child = execFile(harnessBinary, [], {
        env: { ...process.env, BLAME_HARNESS_COMPILER: JSON.stringify([process.execPath, compiler]),
          BLAME_HARNESS_NODE_ASSETS: join(packageRoot, "harness"), BLAME_HARNESS_NODE_MODULES: join(packageRoot, "node_modules") },
        timeout: 60000,
      }, (error, out) => (error ? reject(error) : resolve({ stdout: out })));
      child.stdin.end(input);
    });
    // TypeScript content validation runs in the installed compiler side process.
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ok", stdout);
    assert.notEqual(JSON.stringify(result).match(/"parse":\{"status":"unsupported"/u)?.[0], '"parse":{"status":"unsupported"', stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
