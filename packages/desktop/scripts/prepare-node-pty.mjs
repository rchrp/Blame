import { chmod, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const helperDirectories = ["build/Release", "build/Debug", "prebuilds/darwin-arm64", "prebuilds/darwin-x64"];

async function helpers(packageRoot) {
  const found = [];
  for (const directory of helperDirectories) {
    const path = join(packageRoot, directory, "spawn-helper");
    let info;
    try { info = await lstat(path); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) throw new Error(`node-pty spawn-helper is not a regular file: ${path}`);
    found.push({ path, mode: info.mode });
  }
  if (!found.length) throw new Error(`No macOS node-pty spawn-helper found in ${packageRoot}`);
  return found;
}

// node-pty 1.1.0 ships its Darwin prebuild helpers with mode 0644. Fix every
// candidate: development uses prebuilds, while Electron can prefer a rebuild.
// Run at install/dev time or before code signing, never mutate a signed app.
export async function prepareNodePtyHelpers(packageRoot, platform = process.platform) {
  if (platform !== "darwin") return;
  const root = packageRoot ?? dirname(require.resolve("node-pty/package.json"));
  for (const { path, mode } of await helpers(root)) {
    if ((mode & 0o111) !== 0o111) await chmod(path, mode | 0o111);
  }
}

export async function verifyNodePtyHelpers(packageRoot) {
  for (const { path, mode } of await helpers(packageRoot)) {
    if ((mode & 0o111) !== 0o111) throw new Error(`Packaged node-pty spawn-helper is not executable: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareNodePtyHelpers();
}
