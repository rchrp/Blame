import { access, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Dependencies publish files the packaged app never loads: source maps,
// TypeScript sources next to their compiled JavaScript, tests, examples,
// documentation, tree-sitter grammars' C sources, and native binaries built for
// other platforms. Removing them from the staged node_modules makes installers
// smaller and faster to package, sign and notarize. Declaration files stay:
// the agent runtime runs the TypeScript language service, which reads
// typescript/lib/*.d.ts. Licence files stay too.

// Like electron-builder's defaults, only at the root of a package, but also
// for scoped packages and pnpm's nested node_modules.
const packageRootDirectories = new Set([
  "__tests__",
  "example",
  "examples",
  "test",
  "tests",
]);
const sourceMap = /\.map$/;
const typeScriptSource = /\.(?:[cm]?ts|tsx)$/;
const declaration = /\.d\.[cm]?ts$/;
const documentation = /\.(?:md|markdown)$/i;
const licence = /^(?:licen[cs]e|copying|notice)/i;

// Native binaries per platform, as node-gyp-build and node-pty resolve them:
// prebuilds/<process.platform>-<process.arch>.
const platformPrebuild = /^(?:darwin|linux|win32)-(?:arm64|ia32|x64)$/;
// Naming used by @ast-grep/setup-lang to resolve a grammar's parser.
const prebuildPlatforms = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const prebuildArchitectures = { arm64: "ARM64", x64: "X64" };

/**
 * Removes unused dependency files from `<root>/node_modules` for one target.
 * @param {string} root staged application directory
 * @param {{ platform: string, arch: string }} target
 */
export async function pruneNodeModules(root, target) {
  const context = {
    platformPrebuild: `${target.platform}-${target.arch}`,
    prebuild: prebuildName(target),
    removed: { bytes: 0, files: 0 },
  };
  await pruneModules(join(root, "node_modules"), context);
  return context.removed;
}

// A node_modules directory: its children are packages, scopes or pnpm's store.
async function pruneModules(directory, context) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.name === ".pnpm") {
      for (const store of await readdir(path, { withFileTypes: true })) {
        const modules = join(path, store.name, "node_modules");
        if (store.isDirectory() && (await exists(modules)))
          await pruneModules(modules, context);
      }
    } else if (entry.name.startsWith("@")) {
      await pruneModules(path, context);
    } else {
      await prunePackage(path, context);
    }
  }
}

async function prunePackage(directory, context) {
  const grammar = await prebuiltGrammar(directory, context.prebuild);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) {
      if (removableFile(entry.name)) await remove(path, context.removed);
    } else if (
      packageRootDirectories.has(entry.name) ||
      (grammar && entry.name === "src")
    ) {
      await remove(path, context.removed);
    } else if (grammar && entry.name === "prebuilds") {
      await prunePrebuilds(path, context);
    } else if (entry.name === "prebuilds") {
      await prunePlatformPrebuilds(path, context);
    } else if (entry.name === "node_modules") {
      await pruneModules(path, context);
    } else {
      await pruneFiles(path, context);
    }
  }
}

async function pruneFiles(directory, context) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") await pruneModules(path, context);
      else await pruneFiles(path, context);
    } else if (removableFile(entry.name)) {
      await remove(path, context.removed);
    }
  }
}

// A tree-sitter grammar whose parser ships prebuilt for this target: its C
// sources and the binaries for other platforms are never loaded.
async function prebuiltGrammar(directory, prebuild) {
  if (!prebuild) return false;
  return (
    (await exists(join(directory, "src", "parser.c"))) &&
    (await exists(join(directory, "prebuilds", prebuild)))
  );
}

async function prunePrebuilds(directory, context) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("prebuild-") && entry.name !== context.prebuild)
      await remove(join(directory, entry.name), context.removed);
  }
}

async function prunePlatformPrebuilds(directory, context) {
  const entries = await readdir(directory, { withFileTypes: true });
  // Without a binary for this target, keep everything.
  if (!entries.some((entry) => entry.name === context.platformPrebuild)) return;
  for (const entry of entries) {
    if (
      platformPrebuild.test(entry.name) &&
      entry.name !== context.platformPrebuild
    )
      await remove(join(directory, entry.name), context.removed);
  }
}

function removableFile(name) {
  if (sourceMap.test(name)) return true;
  if (typeScriptSource.test(name) && !declaration.test(name)) return true;
  return documentation.test(name) && !licence.test(name);
}

function prebuildName({ platform, arch }) {
  const os = prebuildPlatforms[platform];
  const cpu = prebuildArchitectures[arch];
  return os && cpu ? `prebuild-${os}-${cpu}` : undefined;
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function remove(path, removed) {
  const { bytes, files } = await measure(path);
  await rm(path, { force: true, recursive: true });
  removed.bytes += bytes;
  removed.files += files;
}

async function measure(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return { bytes: stats.size, files: 1 };
  const total = { bytes: 0, files: 0 };
  for (const entry of await readdir(path)) {
    const child = await measure(join(path, entry));
    total.bytes += child.bytes;
    total.files += child.files;
  }
  return total;
}
