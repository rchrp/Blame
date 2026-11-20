import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRuntimeDir = join(rootDir, "packages/agent-runtime");
const agentRuntimeDist = join(agentRuntimeDir, "dist");
const payloadName = "blame-semantic-harness.tgz";
const { preProcessFile } = createRequire(join(agentRuntimeDir, "package.json"))("typescript");
// The Node side of blame-harness in the runtime VM: the compiler side
// process (its command, `blame-semantic-harness`), the Node test reporter
// and the Vitest preload hook it adds to owned test invocations, and what
// it takes from node_modules. Dependencies: the npm packages these modules
// import, plus those found by name only: the ast-grep grammars, the bundled
// package managers and ripgrep.
const entryPoints = [
  "harness/rust-harness-compiler.js",
  // Worker entry points are reached through URLs rather than static imports.
  "harness/semantic-reference-worker.js",
  "harness/node-event-reporter.js",
  "harness/invocation-test-preload.js",
];
const namedDependencies = [
  "@ast-grep/lang-bash",
  "@ast-grep/lang-c",
  "@ast-grep/lang-cpp",
  "@ast-grep/lang-csharp",
  "@ast-grep/lang-go",
  "@ast-grep/lang-java",
  "@ast-grep/lang-python",
  "@ast-grep/lang-rust",
  "@vscode/ripgrep",
  "npm",
  "npm-legacy",
  "pnpm",
  "pnpm-legacy",
  "yarn",
];

export async function buildSemanticHarnessPayload({ outputPaths, runtimeVersion }) {
  await access(join(agentRuntimeDist, entryPoints[0]));
  const staging = await mkdtemp(join(tmpdir(), "blame-semantic-harness-"));
  try {
    const { files, packages } = await copyRuntimeModules(staging);
    await writePayloadManifest(staging, files, packages, runtimeVersion);
    const archive = await packArchive(staging, join(staging, "packed"));
    for (const outputPath of outputPaths) {
      await mkdir(dirname(outputPath), { recursive: true });
      await rm(outputPath, { force: true });
      await cp(archive, outputPath);
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function writePayloadManifest(staging, runtimeFiles, packages, runtimeVersion) {
  const agentPackage = JSON.parse(await readFile(join(agentRuntimeDir, "package.json"), "utf8"));
  const names = [...new Set([...packages, ...namedDependencies])].sort();
  const missing = names.filter((name) => !agentPackage.dependencies[name]);
  if (missing.length)
    throw new Error(`The harness payload needs undeclared agent-runtime dependencies: ${missing.join(", ")}`);
  const dependencies = Object.fromEntries(names.map((name) => [name, agentPackage.dependencies[name]]));
  const manifest = {
    name: "@blame/semantic-harness-runtime",
    version: payloadVersion(runtimeVersion),
    private: true,
    type: "module",
    bin: { "blame-semantic-harness": entryPoints[0] },
    engines: { node: ">=24.15.0" },
    files: runtimeFiles,
    dependencies,
  };
  await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function packArchive(directory, destination) {
  await mkdir(destination, { recursive: true });
  await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--pack-destination", destination],
    { cwd: directory, shell: process.platform === "win32" });
  const archive = (await readdir(destination)).find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("Runtime npm pack produced no archive");
  return join(destination, archive);
}

async function copyRuntimeModules(staging) {
  const pending = entryPoints.map((entry) => join(agentRuntimeDist, entry));
  const copied = new Set();
  const packages = new Set();
  while (pending.length) {
    const source = pending.pop();
    if (copied.has(source)) continue;
    const local = relative(agentRuntimeDist, source);
    if (local.startsWith("..")) throw new Error("Runtime import escapes its package");
    const imports = preProcessFile(await readFile(source, "utf8"), true, true).importedFiles;
    const destination = join(staging, local);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    copied.add(source);
    for (const { fileName } of imports)
      if (fileName.startsWith(".")) pending.push(resolve(dirname(source), fileName));
      else if (!fileName.startsWith("node:")) packages.add(packageName(fileName));
  }
  const files = [...copied].map((path) => relative(agentRuntimeDist, path).replaceAll("\\", "/"));
  return { files, packages: [...packages] };
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export async function prepareSemanticHarnessPayload(options) {
  await execFileAsync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@blame/agent-runtime", "build"],
    { cwd: rootDir },
  );
  await buildSemanticHarnessPayload(options);
}

export function semanticHarnessPayloadPath(runtimeRoot, platform) {
  return join(runtimeRoot, platform, "payloads", payloadName);
}

function payloadVersion(runtimeVersion) {
  const suffix = String(runtimeVersion).replace(/[^0-9A-Za-z-]/g, "-");
  return `0.0.0-${suffix || "development"}`;
}

async function runCli() {
  const args = process.argv.slice(2);
  const runtimeRootArg = valueArg(args, "--runtime-root");
  if (!runtimeRootArg) return false;
  const runtimeRoot = resolve(process.cwd(), runtimeRootArg);
  const manifest = JSON.parse(
    await readFile(join(runtimeRoot, "macos/manifest.json"), "utf8"),
  );
  await buildSemanticHarnessPayload({
    runtimeVersion: manifest.runtimeVersion,
    outputPaths: [
      semanticHarnessPayloadPath(runtimeRoot, "macos"),
      semanticHarnessPayloadPath(runtimeRoot, "windows"),
    ],
  });
  return true;
}

function valueArg(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!(await runCli())) {
    console.error(
      "Usage: node scripts/semantic-harness-payload.mjs --runtime-root <path>",
    );
    process.exitCode = 2;
  }
}
