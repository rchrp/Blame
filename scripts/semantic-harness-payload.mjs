import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
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
const dependencyNames = [
  "@ast-grep/lang-bash",
  "@ast-grep/lang-c",
  "@ast-grep/lang-cpp",
  "@ast-grep/lang-csharp",
  "@ast-grep/lang-go",
  "@ast-grep/lang-java",
  "@ast-grep/lang-python",
  "@ast-grep/lang-rust",
  "@ast-grep/napi",
  "@cline/sdk",
  "@vscode/ripgrep",
  "diff",
  "@xmldom/xmldom",
  "execa",
  "fast-glob",
  "jsonc-parser",
  "mammoth",
  "pdfjs-dist",
  "read-excel-file",
  "npm",
  "pnpm",
  "proper-lockfile",
  "typescript",
  "write-file-atomic",
  "yarn",
  "zod",
];

export async function buildSemanticHarnessPayload({ outputPaths, runtimeVersion }) {
  await access(join(agentRuntimeDist, "harness/semantic-harness-runner.js"));
  const staging = await mkdtemp(join(tmpdir(), "blame-semantic-harness-"));
  try {
    const runtimeFiles = await copyRuntimeModules(staging);
    await cp(join(rootDir, "scripts/runtime-sdk-check.mjs"), join(staging, "runtime-sdk-check.mjs"));
    const coreManifest = await copyRuntimeSdk(staging);
    await writePayloadManifest(staging, runtimeFiles, coreManifest, runtimeVersion);
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

async function copyRuntimeSdk(staging) {
  const coreRoot = await runtimeCorePackagePath();
  await access(join(coreRoot, "dist/blame-patch.json"));
  // pnpm's generated .bin launchers embed absolute build-machine paths.
  // Dependencies are installed from the payload manifest, so shipping this
  // local node_modules tree only makes otherwise identical payloads differ.
  await cp(coreRoot, join(staging, "vendor/cline-core"), {
    recursive: true,
    filter: (source) => source !== join(coreRoot, "node_modules"),
  });
  return JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"));
}

export async function runtimeCorePackagePath() {
  const sdkRoot = await realpath(join(agentRuntimeDir, "node_modules/@cline/sdk"));
  const locations = createRequire(join(sdkRoot, "package.json")).resolve.paths("@cline/core") ?? [];
  for (const location of locations) {
    try { return dirname(await realpath(join(location, "@cline/core/package.json"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("Cline SDK core dependency is missing");
}

async function writePayloadManifest(staging, runtimeFiles, coreManifest, runtimeVersion) {
  const agentPackage = JSON.parse(await readFile(join(agentRuntimeDir, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(dependencyNames.map((name) => [name, agentPackage.dependencies[name]]));
  const manifest = {
    name: "@blame/semantic-harness-runtime",
    version: payloadVersion(runtimeVersion),
    private: true,
    type: "module",
    bin: { "blame-semantic-harness": "harness/semantic-harness-runner.js" },
    engines: { node: ">=22" },
    files: [...runtimeFiles, "vendor/cline-core", "runtime-sdk-check.mjs"],
    dependencies: { ...coreManifest.dependencies, ...dependencies },
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
  // Worker entry points are reached through URLs rather than static imports.
  const pending = [join(agentRuntimeDist, "harness/semantic-harness-runner.js"),
    join(agentRuntimeDist, "attachment-pdf-worker.js"),
    join(agentRuntimeDist, "harness/semantic-reference-worker.js")];
  const copied = new Set();
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
  }
  return [...copied].map((path) => relative(agentRuntimeDist, path).replaceAll("\\", "/"));
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
