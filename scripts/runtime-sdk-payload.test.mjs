import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const runtimeRoot = resolve(import.meta.dirname, "../packages/desktop/resources/runtime");
const bashAvailable = spawnSync("bash", ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0;
const pythonAvailable = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0;
const scripts = ["macos/scripts/provision-blame-runtime.sh", "windows/scripts/provision-blame-runtime.sh",
  "macos/scripts/blame-lima-runtime.sh", "windows/scripts/blame-wsl2-runtime.ps1"];

async function sdkFixture(root, version, patched) {
  for (const name of ["sdk", "core"]) {
    const folder = join(root, "@cline", name);
    await mkdir(join(folder, "dist"), { recursive: true });
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: `@cline/${name}`, version }));
    await writeFile(join(folder, "dist/index.js"), "");
  }
  if (!patched) return;
  const core = join(root, "../vendor/cline-core");
  await mkdir(join(core, "dist"), { recursive: true });
  await writeFile(join(core, "package.json"), JSON.stringify({ name: "@cline/core", version }));
  await writeFile(join(core, "dist/blame-patch.json"), "");
}

function healthCheck(source, globalRoot) {
  const functions = [...source.matchAll(/^valid_cline_sdk_install\(\) \{[\s\S]*?^\}/gm)];
  assert.ok(functions.length);
  return functions.map(([body]) => {
    const script = 'npm() { printf "%s" "$BLAME_TEST_GLOBAL_ROOT"; }\nnode_major_ok() { return 0; }\ncline_sdk_version="0.0.81"\n' +
      body.replaceAll("__CLINE_SDK_VERSION__", "0.0.81") + "\nvalid_cline_sdk_install";
    return spawnSync("bash", ["-c", script], { env: { ...process.env, BLAME_TEST_GLOBAL_ROOT: globalRoot }, encoding: "utf8", timeout: 5000 }).status;
  });
}

for (const script of scripts) {
  test(`${script} validates the SDK actually shipped with the runtime`, { skip: !bashAvailable }, async () => {
    const folder = await mkdtemp(join(tmpdir(), "runtime-sdk-health-"));
    const source = await readFile(join(runtimeRoot, script), "utf8");
    try {
      await sdkFixture(folder, "0.0.81", false);
      assert.ok(healthCheck(source, folder).every(status => status !== 0));
      const bundled = join(folder, "@blame/semantic-harness-runtime/node_modules");
      await sdkFixture(bundled, "0.0.81", true);
      assert.ok(healthCheck(source, folder).every(status => status === 0));
      await writeFile(join(bundled, "../vendor/cline-core/package.json"), '{"version":"0.0.82"}');
      assert.ok(healthCheck(source, folder).every(status => status !== 0));
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

const pythonProbe = String.raw`
import ast, json, os, sys
from pathlib import Path
source = Path(sys.argv[1]).read_text()
body = source.split("cat >/usr/local/bin/blame-runtime-agent <<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
names = {"cline_hub_module_path", "cline_hub_build_id"}
functions = [node for node in ast.parse(body).body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(functions) == 2
expected = os.path.join(sys.argv[2], "@blame", "semantic-harness-runtime", "vendor", "cline-core", "dist", "index.js")
captured = []
def run_node_json(script):
    captured.append(script)
    return {"buildId": "fixture-build"}
scope = {"json": json, "os": os, "npm_root": lambda: sys.argv[2], "run_node_json": run_node_json}
exec(compile(ast.Module(body=functions, type_ignores=[]), "runtime-sdk", "exec"), scope)
assert scope["cline_hub_module_path"]() == expected
assert scope["cline_hub_build_id"]() == "fixture-build"
assert "file://" + expected in captured[0] and "resolveHubBuildId" in captured[0]
`;

for (const platform of ["macos", "windows"]) {
  test(`${platform} starts the packaged SDK and reads its build identity`, { skip: !pythonAvailable }, () => runtimeModuleProbe(platform));
}

async function runtimeModuleProbe(platform) {
  const folder = await mkdtemp(join(tmpdir(), "runtime-sdk-module-"));
  try {
    const entry = join(folder, "@blame/semantic-harness-runtime/vendor/cline-core/dist/index.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "");
    const script = join(runtimeRoot, platform, "scripts/provision-blame-runtime.sh");
    const result = spawnSync("python3", ["-c", pythonProbe, script, folder], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally { await rm(folder, { recursive: true, force: true }); }
}
