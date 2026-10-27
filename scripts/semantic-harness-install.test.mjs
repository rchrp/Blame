import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildSemanticHarnessPayload } from "./semantic-harness-payload.mjs";
import { runtimeClineSdkVersion } from "./runtime-sdk-version.mjs";

const execute = promisify(execFile);

test("fresh npm installation starts the distributed harness and verifies its SDK", { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-npm-smoke-"));
  try {
    const archive = join(directory, "runtime.tgz");
    await buildSemanticHarnessPayload({ outputPaths: [archive], runtimeVersion: "npm-test" });
    await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--global", "--prefix", directory, "--no-audit", "--no-fund", archive],
      { shell: process.platform === "win32", timeout: 240000, maxBuffer: 1024 * 1024 });
    const packageRoot = join(directory, process.platform === "win32" ? "node_modules" : "lib/node_modules", "@blame/semantic-harness-runtime");
    await execute(process.execPath, [join(packageRoot, "runtime-sdk-check.mjs"), await runtimeClineSdkVersion()]);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "package.json"), '{"scripts":{}}');
    const input = JSON.stringify({ tool: "read_code", input: { target: "@capabilities" }, taskContract: { session_id: "npm-install-test" }, workspaceRoot: workspace });
    const script = 'process.stdin.push(process.argv[2]); process.stdin.push(null); import(process.argv[1]);';
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(join(packageRoot, "harness/semantic-harness-runner.js")).href, input]);
    assert.equal(JSON.parse(stdout).status, "ok");
    const managerScript = `
      import { execFileSync } from 'node:child_process';
      const { resolvePackageManager } = await import(process.argv[1]);
      const manager = await resolvePackageManager({ name: 'pnpm', version: process.argv[2] });
      process.stdout.write(execFileSync(manager.executable, [...manager.argsPrefix, '--version']));
    `;
    for (const version of ["12.15.0", "10.33.2"]) {
      const result = await execute(process.execPath, ["--input-type=module", "-e", managerScript,
        pathToFileURL(join(packageRoot, "harness/package-manager-runtime.js")).href, version], {
        cwd: workspace,
        env: { ...process.env, COREPACK_ENABLE_NETWORK: "0", npm_config_manage_package_manager_versions: "false" },
        timeout: 15000,
      });
      assert.equal(result.stdout.trim(), version);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
