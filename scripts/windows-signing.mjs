// Release steps around SignPath, which signs the Windows app in two requests:
// Blame.exe first, then the installer built around the signed Blame.exe.
// Signing changes the installer's bytes, so its update metadata (latest.yml and
// the blockmap) is rebuilt afterwards. The release's SHA256SUMS is computed
// later, from the uploaded files, by `desktop-release.mjs collect`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(rootDir, "packages/desktop");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const YAML = requireDesktop("yaml");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version") console.log(windowsProductVersion(args[0]));
  else if (command === "installer") await buildInstaller(args[0], args[1]);
  else if (command === "update-info") await refreshUpdateInfo(args[0], args[1]);
  else {
    console.log(
      [
        "Usage:",
        "  node scripts/windows-signing.mjs version <semver>                  Four-part version Windows stores in Blame.exe",
        "  node scripts/windows-signing.mjs installer <signed exe> <app dir>  Build the installer around the signed Blame.exe",
        "  node scripts/windows-signing.mjs update-info <signed installer>    Replace the installer and rebuild latest.yml and its blockmap",
      ].join("\n"),
    );
    process.exit(command ? 1 : 0);
  }
}

// electron-builder writes major.minor.patch.0 as Blame.exe's ProductVersion,
// without the prerelease suffix.
export function windowsProductVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version ?? "");
  if (!match) throw new Error(`Not a semver version: ${version}`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

// Puts the signed Blame.exe into the unpacked app, moves the app out of dist,
// and packages it again as an NSIS installer without rebuilding it.
async function buildInstaller(signedExe, appDir) {
  if (!signedExe || !appDir) {
    throw new Error("Usage: installer <signed Blame.exe> <app directory>");
  }
  const unpacked = join(desktopDir, "dist/win-unpacked");
  await cp(resolve(signedExe), join(unpacked, "Blame.exe"));
  await rm(resolve(appDir), { force: true, recursive: true });
  await rename(unpacked, resolve(appDir)).catch(async (error) => {
    if (error.code !== "EXDEV") throw error;
    await cp(unpacked, resolve(appDir), { recursive: true, verbatimSymlinks: true });
  });
  await rm(join(desktopDir, "dist"), { force: true, recursive: true });
  await run("pnpm", [
    "exec",
    "electron-builder",
    "--projectDir",
    desktopDir,
    "--config",
    join(desktopDir, "electron-builder.config.ts"),
    "--win",
    "--x64",
    "--prepackaged",
    resolve(appDir),
    "--publish",
    "never",
  ]);
}

// Copies the signed installer over the unsigned one and recomputes what
// electron-updater checks: the blockmap, and the sha512 and size in latest.yml.
export async function refreshUpdateInfo(signedInstaller, distDir = join(desktopDir, "dist")) {
  if (!signedInstaller) throw new Error("Usage: update-info <signed installer> [dist directory]");
  const name = basename(signedInstaller);
  const installer = join(distDir, name);
  const metadataFile = join(distDir, "latest.yml");
  // Edited as a document so that everything else keeps its exact formatting.
  const metadata = YAML.parseDocument(await readFile(metadataFile, "utf8"));
  const files = metadata.toJS().files ?? [];
  const index = files.findIndex((file) => file.url === name);
  if (index < 0 || files.findLastIndex((file) => file.url === name) !== index) {
    throw new Error(`latest.yml does not list ${name} once`);
  }

  await cp(resolve(signedInstaller), installer);
  const { size, sha512 } = await buildBlockMap(installer);
  const [actualSize, actualSha512] = await Promise.all([
    stat(installer).then((info) => info.size),
    sha512File(installer),
  ]);
  if (size !== actualSize || sha512 !== actualSha512) {
    throw new Error(`The blockmap of ${name} does not match the signed file`);
  }
  metadata.setIn(["files", index, "sha512"], sha512);
  metadata.setIn(["files", index, "size"], size);
  if (metadata.get("path") === name) metadata.set("sha512", sha512);
  await writeFile(metadataFile, metadata.toString(), "utf8");
  console.log(`Updated latest.yml and ${name}.blockmap for the signed installer (${size} bytes)`);
}

async function buildBlockMap(file) {
  const builder = createRequire(requireDesktop.resolve("electron-builder"));
  const { buildBlockMap: build } = builder("app-builder-lib/out/targets/blockmap/blockmap.js");
  return build(file, "gzip", `${file}.blockmap`);
}

function sha512File(file) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha512");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", rejectHash)
      .once("end", () => resolveHash(hash.digest("base64")));
  });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      env: { ...process.env, BLAME_DESKTOP_NPM_REBUILD: "false", JITI_FS_CACHE: "false" },
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}
