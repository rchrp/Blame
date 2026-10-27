import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./env-files.mjs";
import { sha256File } from "./file-sha256.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(rootDir, "packages/desktop");
const distDir = join(desktopDir, "dist");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const YAML = requireDesktop("yaml");
const command = process.argv[2] ?? "help";
const commandArgs = process.argv.slice(3);
const args = commandArgs[0] === "--" ? commandArgs.slice(1) : commandArgs;

await loadEnvFiles(rootDir);

if (command === "build") await build(args);
else if (command === "collect") await collect(...args);
else {
  printHelp();
  process.exit(command === "help" ? 0 : 1);
}

async function build(platformArgs) {
  // Same update feed and published runtimes as production builds.
  process.env.BLAME_DOWNLOAD_BASE_URL ||= "https://download.blame.so/latest";
  const packageArgs = platformArgs.length ? platformArgs : hostPlatformArgs();
  await run("pnpm", ["--filter", "@blame/desktop", "build"], rootDir);
  await run("pnpm", ["--filter", "@blame/desktop", "test:startup"], rootDir);
  if (isDualArchitectureMacosBuild(packageArgs)) {
    await buildMacosArchitectures(packageArgs);
    return;
  }
  await packageDesktop(packageArgs);
}

async function packageDesktop(packageArgs) {
  await run(
    "pnpm",
    [
      "--filter",
      "@blame/desktop",
      "package",
      "--",
      ...packageArgs,
      "--publish",
      "never",
    ],
    rootDir,
  );
}

async function buildMacosArchitectures(packageArgs) {
  const commonArgs = packageArgs.filter(
    (argument) => argument !== "--x64" && argument !== "--arm64",
  );
  const firstDist = await mkdtemp(join(tmpdir(), "blame-desktop-x64-"));

  try {
    await packageDesktop([...commonArgs, "--x64"]);
    await cp(distDir, firstDist, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const x64Update = await readMacosUpdateMetadata(firstDist);

    await packageDesktop([...commonArgs, "--arm64"]);
    const arm64Update = await readMacosUpdateMetadata(distDir);
    await restoreUniqueReleaseFiles(firstDist);
    await writeMacosUpdateMetadata(mergeMacosUpdates(x64Update, arm64Update));
  } finally {
    await rm(firstDist, { force: true, recursive: true });
  }
}

function isDualArchitectureMacosBuild(packageArgs) {
  return (
    packageArgs.some(
      (argument) => argument === "--mac" || argument === "mac",
    ) &&
    packageArgs.includes("--x64") &&
    packageArgs.includes("--arm64")
  );
}

async function readMacosUpdateMetadata(directory) {
  return YAML.parse(await readFile(join(directory, "latest-mac.yml"), "utf8"));
}

async function restoreUniqueReleaseFiles(sourceDirectory) {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "latest-mac.yml") continue;
    const destination = join(distDir, entry.name);
    try {
      await readFile(destination);
    } catch {
      await cp(join(sourceDirectory, entry.name), destination);
    }
  }
}

function mergeMacosUpdates(x64Update, arm64Update) {
  const files = new Map();
  for (const file of [
    ...(x64Update.files ?? []),
    ...(arm64Update.files ?? []),
  ]) {
    files.set(file.url, file);
  }
  return {
    ...x64Update,
    files: [...files.values()],
    releaseDate: arm64Update.releaseDate ?? x64Update.releaseDate,
  };
}

async function writeMacosUpdateMetadata(metadata) {
  await writeFile(
    join(distDir, "latest-mac.yml"),
    YAML.stringify(metadata),
    "utf8",
  );
}

function hostPlatformArgs() {
  const platform = { darwin: "--mac", win32: "--win" }[process.platform];
  const architecture = process.arch === "arm64" ? "--arm64" : "--x64";
  return [platform ?? "--linux", architecture];
}

// Flattens the per-platform CI artifacts into one GitHub Release asset set.
async function collect(sourceDirectory, outputDirectory) {
  if (!sourceDirectory || !outputDirectory) {
    throw new Error("Usage: collect <artifacts directory> <output directory>");
  }
  const output = resolve(rootDir, outputDirectory);
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { recursive: true });

  const files = await releaseFiles(resolve(rootDir, sourceDirectory), output);
  assertCompleteRelease(files);
  const checksums = [];
  for (const file of files.sort((a, b) => basename(a).localeCompare(basename(b)))) {
    const destination = join(output, basename(file));
    if (file !== destination) await cp(file, destination);
    checksums.push(`${await sha256File(destination)}  ${basename(file)}`);
  }
  await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`, "utf8");
}

async function releaseFiles(directory, outputDirectory) {
  const files = await recursiveReleaseFiles(directory);
  const grouped = Map.groupBy(files, (file) => file.name);
  const resolved = [];
  for (const [name, matches] of grouped) {
    if (matches.length === 1) {
      resolved.push(matches[0].path);
      continue;
    }
    if (name !== "latest-mac.yml") {
      throw new Error(`Duplicate release file: ${name}`);
    }
    resolved.push(await mergeMacosMetadata(matches, outputDirectory));
  }
  return resolved;
}

async function recursiveReleaseFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveReleaseFiles(path)));
    else if (entry.isFile() && isReleaseFile(entry.name)) {
      files.push({ name: entry.name, path });
    }
  }
  return files;
}

async function mergeMacosMetadata(files, outputDirectory) {
  const metadata = await Promise.all(
    files.map(async ({ path }) => YAML.parse(await readFile(path, "utf8"))),
  );
  const merged = metadata.slice(1).reduce(mergeMacosUpdates, metadata[0]);
  const destination = join(outputDirectory, "latest-mac.yml");
  await writeFile(destination, YAML.stringify(merged), "utf8");
  return destination;
}

function isReleaseFile(file) {
  if (file.startsWith("latest") && file.endsWith(".yml")) return true;
  if (file.endsWith(".blockmap")) return true;
  return [".AppImage", ".deb", ".dmg", ".exe", ".rpm", ".zip"].includes(
    extname(file),
  );
}

function assertCompleteRelease(files) {
  const fileNames = new Set(files.map((file) => basename(file)));
  const requiredMetadata = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
  const missing = requiredMetadata.filter((name) => !fileNames.has(name));
  if (missing.length) {
    throw new Error(`Incomplete desktop release, missing ${missing.join(", ")}`);
  }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(`${command} ${args.join(" ")} exited with ${code}`),
        );
    });
  });
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/desktop-release.mjs build [electron-builder args]   Build installers into packages/desktop/dist (host platform by default)",
      "  node scripts/desktop-release.mjs collect <artifacts> <output>    Merge CI artifacts into a release directory with SHA256SUMS",
    ].join("\n"),
  );
}
