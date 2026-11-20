import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  realpath,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildSemanticHarnessPayload } from "./semantic-harness-payload.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const agentRuntimeDir = join(rootDir, "packages/agent-runtime");

// The payload is the Node side of blame-harness in the runtime VM: the
// harness runs against it with the environment the VM's launcher gives it
// (packages/desktop/src/main/engine/vm-engine.ts), one request per process.
const harnessBinary = process.env.BLAME_HARNESS_BIN ??
  join(rootDir, "target/debug", process.platform === "win32" ? "blame-harness.exe" : "blame-harness");

test("standalone payload serves blame-harness's compiler tier and commands", async () => {
  await withPayload(async (packageRoot, workspaceRoot) => {
    await assert.rejects(access(join(packageRoot, "harness/semantic-harness-runner.js")));
    await assert.rejects(access(join(packageRoot, "harness/light-workspace.js")));
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.dependencies["@cline/sdk"], undefined);
    const result = await executeRunner(packageRoot, workspaceRoot);
    assert.equal(result.status, "ok");
    assert.match(JSON.stringify(result.data), /Symbol read\/edit/u);
    const command = await executeRunner(packageRoot, workspaceRoot, {
      tool: "run_task", input: { kind: "command", command: "node -e \"console.log('payload-ready')\"" },
    });
    assert.equal(command.status, "ok", JSON.stringify(command));
    assert.match(command.data.output, /payload-ready/);
    await writeFile(join(workspaceRoot, "module.ts"), "export function target() {\n  return 1;\n}\n");
    const observed = await executeRunner(packageRoot, workspaceRoot, {
      tool: "read_code", input: { target: "module.ts#target" },
    });
    const edited = await executeRunner(packageRoot, workspaceRoot, {
      tool: "edit_code", input: { operations: [{ kind: "patch", target: observed.data.alias,
        patch: "*** Begin Patch\n*** Update File: module.ts\n@@\n-  return 1;\n+  return 2;\n*** End Patch" }] },
    });
    assert.equal(edited.status, "ok", JSON.stringify(edited));
    assert.match(await readFile(join(workspaceRoot, "module.ts"), "utf8"), /return 2/u);
    await writeFile(join(workspaceRoot, "consumer.ts"),
      'import { target as aliased } from "./module.js";\nexport const value = aliased();\n');
    await writeFile(join(workspaceRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, types: [], module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["*.ts"],
    }));
    const references = await executeRunner(packageRoot, workspaceRoot, {
      tool: "search_code", input: { mode: "references", query: "module.ts#target" },
    });
    assert.equal(references.status, "ok", JSON.stringify(references));
    assert.equal(references.data.engine, "typescript_language_service", JSON.stringify(references));
    assert.equal(references.data.referenceCount, 2);
    await executeRunner(packageRoot, workspaceRoot, {
      tool: "read_code", input: { target: "module.ts#target", view: "symbol" },
    });
    const renamed = await executeRunner(packageRoot, workspaceRoot, {
      tool: "edit_code", input: { operations: [
        { kind: "symbol", target: "module.ts#target", action: "rename", content: "updatedTarget" },
      ] },
    });
    assert.equal(renamed.status, "ok", JSON.stringify(renamed));
    assert.equal(renamed.data.semanticRename.engine, "typescript_language_service");
    assert.match(await readFile(join(workspaceRoot, "module.ts"), "utf8"), /function updatedTarget/u);
    assert.match(await readFile(join(workspaceRoot, "consumer.ts"), "utf8"), /updatedTarget as aliased/u);
  });
});

test("standalone payload executes optional symbolic analysis without granting validation", {
  skip: !process.env.BLAME_Z3_PATH && "Set BLAME_Z3_PATH to test the optional local solver",
}, async () => {
  await withPayload(async (packageRoot, workspaceRoot) => {
    await writeFile(join(workspaceRoot, "budget.ts"),
      "export function remaining(limit: number, used: number): number { return limit + used; }\n");
    const result = await executeRunner(packageRoot, workspaceRoot, {
      tool: "run_task", input: { kind: "analyze", target: "budget.ts#remaining",
        inputs: { limit: { min: 0, max: 10 }, used: { min: 0, max: 10 } },
        assertion: "result === limit - used" },
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(result.data.status, "counterexample", JSON.stringify(result));
    assert.equal(result.data.validationAdmission, false);
    assert.equal(result.data.witness.concretelyReproduced, true);
    const checks = await executeRunner(packageRoot, workspaceRoot, {
      tool: "read_code", input: { target: "@checks" },
    });
    assert.equal(checks.status, "ok", JSON.stringify(checks));
    assert.equal(checks.data.total, 0);
  });
});

async function withPayload(action) {
  const temporary = await mkdtemp(join(tmpdir(), "semantic-payload-test-"));
  try {
    const archive = join(temporary, "semantic-harness.tgz");
    const installRoot = join(temporary, "install");
    const workspaceRoot = join(temporary, "workspace");
    await buildSemanticHarnessPayload({ outputPaths: [archive], runtimeVersion: "payload-test" });
    await extractArchive(archive, installRoot);
    const packageRoot = join(installRoot, "package");
    await linkRuntimeDependencies(packageRoot);
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "package.json"), '{"scripts":{}}\n');
    await action(packageRoot, workspaceRoot);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function extractArchive(archive, destination) {
  await mkdir(destination);
  await runProcess("tar", ["-xzf", archive, "-C", destination]);
}

async function linkRuntimeDependencies(packageRoot) {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = join(packageRoot, "node_modules", name);
    const source = await realpath(join(agentRuntimeDir, "node_modules", name));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(source, destination, process.platform === "win32" ? "junction" : undefined);
  }
}

async function executeRunner(packageRoot, workspaceRoot, request = {}) {
  const stdout = await runProcess(
    harnessBinary,
    [],
    JSON.stringify({
      input: { target: "@capabilities" },
      taskContract: { session_id: "payload-e2e" },
      tool: "read_code",
      workspaceRoot,
      ...request,
    }),
    packageRoot,
  );
  return JSON.parse(stdout);
}

function harnessEnvironment(packageRoot) {
  if (!packageRoot) return process.env;
  return {
    ...process.env,
    BLAME_HARNESS_COMPILER: JSON.stringify([process.execPath, join(packageRoot, "harness/rust-harness-compiler.js")]),
    BLAME_HARNESS_NODE_ASSETS: join(packageRoot, "harness"),
    BLAME_HARNESS_NODE_MODULES: join(packageRoot, "node_modules"),
  };
}

function runProcess(command, args, input, packageRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: harnessEnvironment(packageRoot) });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
    child.stdin.end(input);
  });
}

test("standalone payload returns image media with the forwarded model capability", async () => {
  await withPayload(async (packageRoot, workspaceRoot) => {
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=", "base64");
    await writeFile(join(workspaceRoot, "pixel.png"), pixel);
    const result = await executeRunner(packageRoot, workspaceRoot, {
      input: { target: "pixel.png" }, toolContext: { metadata: { modelSupportsImages: true } },
    });
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(result.content, [{ type: "image", mediaType: "image/png", data: pixel.toString("base64") }]);
  });
});

test("rebuilding an unchanged payload preserves its update fingerprint", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "semantic-payload-stable-"));
  try {
    const first = join(temporary, "first.tgz");
    const second = join(temporary, "second.tgz");
    await buildSemanticHarnessPayload({ outputPaths: [first], runtimeVersion: "stable-test" });
    await buildSemanticHarnessPayload({ outputPaths: [second], runtimeVersion: "stable-test" });
    assert.deepEqual(await readFile(first), await readFile(second));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
