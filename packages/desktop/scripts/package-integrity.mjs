import { access, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, normalize, posix, relative, sep } from "node:path";
import {
  engineExecutables,
  packagedEngineTargets,
} from "../../../scripts/build-engine-binaries.mjs";
import { checkJavaScript } from "./check-generated-javascript.mjs";
import { verifyNodePtyHelpers } from "./prepare-node-pty.mjs";

function runtimeTargets(manifest) {
  const paths = new Set();
  if (manifest.main) paths.add(manifest.main);
  function visit(value) {
    if (typeof value === "string") {
      if (!value.includes("*")) paths.add(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value) {
      for (const [condition, target] of Object.entries(value)) {
        if (condition !== "types") visit(target);
      }
    }
  }
  visit(manifest.exports);
  return [...paths];
}

/** Check the published runtime targets, not the source paths used by tsc. */
export async function verifyWorkspaceRuntime(
  read,
  exists,
  canonical = (path) => path,
) {
  const pending = [""];
  const checked = new Set();
  while (pending.length) {
    const directory = await canonical(pending.pop());
    if (checked.has(directory)) continue;
    checked.add(directory);
    const manifest = JSON.parse(
      await read(posix.join(directory, "package.json")),
    );
    for (const target of runtimeTargets(manifest)) {
      const path = posix.join(directory, target);
      if (!(await exists(path)))
        throw new Error(
          `Desktop package is missing runtime entrypoint: ${path}`,
        );
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith("@blame/")) continue;
      let parent = directory;
      let dependency;
      while (true) {
        const candidate = posix.join(parent, "node_modules", name);
        if (await exists(posix.join(candidate, "package.json"))) {
          dependency = candidate;
          break;
        }
        if (!parent || parent === ".") break;
        parent = posix.dirname(parent);
      }
      if (!dependency)
        throw new Error(
          `Desktop package is missing workspace dependency: ${name} (from ${manifest.name})`,
        );
      pending.push(dependency);
    }
  }
  return checked.size;
}

export function verifyStagedWorkspaceRuntime(root) {
  return verifyWorkspaceRuntime(
    (path) => readFile(join(root, path), "utf8"),
    async (path) => {
      try {
        await access(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
    async (path) => {
      const resolved = relative(
        await realpath(root),
        await realpath(join(root, path)),
      );
      if (resolved === ".." || resolved.startsWith(`..${sep}`)) {
        throw new Error(
          `Desktop workspace dependency escapes staging: ${path}`,
        );
      }
      return resolved.split(sep).join("/");
    },
  );
}

function asarTools() {
  // Resolve from the installed builder, not from the production staging tree.
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  return createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
}

export function verifyAsarWorkspaceRuntime(archive) {
  const asar = asarTools();
  // The traversal uses POSIX paths, but ASAR splits directories with path.sep.
  // Convert at this boundary so nested entries can also be found on Windows.
  return verifyWorkspaceRuntime(
    (path) => asar.extractFile(archive, normalize(path)).toString("utf8"),
    async (path) => {
      try {
        const info = asar.statFile(archive, normalize(path));
        if (info.unpacked) await access(join(`${archive}.unpacked`, path));
        return !info.files;
      } catch {
        return false;
      }
    },
  );
}

// The agent runtime's TypeScript language service resolves built-in types
// from the compiler's default libraries, which electron-builder drops with
// every other .d.ts unless electron-builder.config.ts forces them in.
const requiredTypeScriptLibraries = ["lib.d.ts", "lib.es5.d.ts", "lib.dom.d.ts"];

export function verifyAsarTypeScriptLibraries(archive) {
  const asar = asarTools();
  const entries = new Set(
    asar.listPackage(archive).map((entry) => entry.split(sep).join("/")),
  );
  const compilers = [...entries].filter((entry) =>
    /(?:^|\/)node_modules\/(?:typescript|@typescript\/(?:typescript6|old))\/lib\/typescript\.js$/.test(entry),
  );
  for (const compiler of compilers) {
    // The official TypeScript 6 compatibility package forwards to @typescript/old.
    const source = asar.extractFile(archive, normalize(compiler.replace(/^\//, ""))).toString("utf8");
    if (/^\s*module\.exports\s*=\s*require\(["']@typescript\/old["']\);?\s*$/.test(source)) {
      let parent = posix.dirname(posix.dirname(compiler));
      while (!entries.has(posix.join(parent, "node_modules/@typescript/old/lib/typescript.js"))) {
        const ancestor = posix.dirname(parent);
        if (ancestor === parent)
          throw new Error(`Desktop package is missing the TypeScript compatibility implementation: ${compiler}`);
        parent = ancestor;
      }
      continue;
    }
    const directory = posix.dirname(compiler);
    for (const library of requiredTypeScriptLibraries) {
      if (!entries.has(posix.join(directory, library)))
        throw new Error(
          `Desktop package is missing TypeScript default library: ${posix.join(directory, library)}`,
        );
    }
  }
  return compilers.length;
}

async function verifyUnpackedNpm(archive) {
  const asar = asarTools();
  for (const entry of asar.listPackage(archive)) {
    const path = entry.split(sep).join("/").replace(/^\//, "");
    if (!/(?:^|\/)node_modules\/npm(?:-legacy)?\/package\.json$/.test(path)) continue;
    const manifest = JSON.parse(asar.extractFile(archive, normalize(path)).toString("utf8"));
    const executable = join(`${archive}.unpacked`, posix.dirname(path), manifest.bin.npm);
    const { stdout } = await promisify(execFile)(process.execPath, [executable, "--version"], { timeout: 15000 });
    if (stdout.trim() !== manifest.version)
      throw new Error(`Packaged npm version mismatch in ${path}: ${stdout.trim()}`);
  }
}

// The agent's browser tools run agent-browser's native binary: exactly one,
// for the target, outside the archive. It runs when the host can run it.
export async function verifyUnpackedAgentBrowser(archive) {
  const asar = asarTools();
  const manifests = asar
    .listPackage(archive)
    .map((entry) => entry.split(sep).join("/").replace(/^\//, ""))
    .filter((path) => /(?:^|\/)node_modules\/@agent-browser\/cli-[\w-]+\/package\.json$/.test(path));
  if (manifests.length !== 1)
    throw new Error(`Desktop package needs one agent-browser binary, found ${manifests.length} in ${archive}`);
  const manifest = JSON.parse(asar.extractFile(archive, normalize(manifests[0])).toString("utf8"));
  const name = manifest.os?.includes("win32") ? "agent-browser.exe" : "agent-browser";
  const executable = join(`${archive}.unpacked`, posix.dirname(manifests[0]), "bin", name);
  await access(executable);
  if (!manifest.os?.includes(process.platform) || !manifest.cpu?.includes(process.arch)) return;
  const { stdout } = await promisify(execFile)(executable, ["--version"], { timeout: 15000 });
  if (stdout.trim() !== `agent-browser ${manifest.version}`)
    throw new Error(`Packaged agent-browser version mismatch in ${manifests[0]}: ${stdout.trim()}`);
}

export function verifyAsarGeneratedJavaScript(archive) {
  const asar = asarTools();
  let count = 0;
  for (const entry of asar.listPackage(archive)) {
    const path = entry.split(sep).join("/").replace(/^\//, "");
    if (!/^out\/(?:main|preload)\/.*\.[cm]?js$/.test(path)) continue;
    checkJavaScript(asar.extractFile(archive, normalize(path)).toString("utf8"),
      `${archive}/${path}`, path.startsWith("out/preload/") ? "commonjs" : "module");
    count++;
  }
  if (!count) throw new Error(`No generated main/preload JavaScript in ${archive}`);
  return count;
}

// The Rust binaries in resources/engine (docs/engine-in-the-app.md, "Engine
// binaries"): exactly the app's own target and the VM's Linux one, each an
// executable of that platform and architecture; the Linux ones static, so
// they run in any runtime image. Checked from the file headers, so a package
// built for another platform is checked too.
const executableFormats = {
  darwin: { format: "Mach-O", machines: { arm64: 0x0100000c, x64: 0x01000007 } },
  linux: { format: "ELF", machines: { arm64: 183, x64: 62 } },
  win32: { format: "PE", machines: { arm64: 0xaa64, x64: 0x8664 } },
};

export async function verifyPackagedEngineBinaries(resources, platform) {
  const directory = join(resources, "engine");
  const present = (await readdir(directory).catch(() => [])).sort();
  const own = present.filter((name) => name.startsWith(`${platform}-`));
  const expected =
    own.length === 1
      ? packagedEngineTargets(platform, own[0].slice(platform.length + 1)).sort()
      : [];
  if (!expected.length || present.join() !== expected.join())
    throw new Error(
      `Desktop package needs the engine binaries for one ${platform} target and its VM in ${directory}, found: ${present.join(", ") || "none"}`,
    );
  for (const target of expected) {
    const [targetPlatform, arch] = target.split("-");
    for (const executable of engineExecutables(target)) {
      const path = join(directory, target, executable);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile())
        throw new Error(`Desktop package is missing ${path}`);
      if (process.platform !== "win32" && targetPlatform !== "win32" && !(info.mode & 0o111))
        throw new Error(`Desktop package has a non-executable ${path}`);
      const header = await executableHeader(path);
      const { format, machines } = executableFormats[targetPlatform];
      if (header.format !== format || header.machine !== machines[arch])
        throw new Error(
          `Desktop package needs ${format} for ${arch} at ${path}, found ${header.format ?? "another format"}`,
        );
      if (header.interpreter)
        throw new Error(`Desktop package has a dynamically linked ${path}: the VM needs a static build`);
    }
  }
  return expected;
}

async function executableHeader(path) {
  const file = await open(path, "r");
  try {
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, position);
      return buffer;
    };
    const head = await read(0, 64);
    if (head.readUInt32LE(0) === 0xfeedfacf)
      return { format: "Mach-O", machine: head.readUInt32LE(4) };
    if (head.readUInt32BE(0) === 0x7f454c46) {
      const offset = Number(head.readBigUInt64LE(32));
      const size = head.readUInt16LE(54);
      const count = head.readUInt16LE(56);
      const headers = await read(offset, size * count);
      let interpreter = false;
      for (let index = 0; index < count; index++)
        if (headers.readUInt32LE(index * size) === 3) interpreter = true;
      return { format: "ELF", machine: head.readUInt16LE(18), interpreter };
    }
    if (head.toString("latin1", 0, 2) === "MZ") {
      const pe = await read(head.readUInt32LE(0x3c), 6);
      if (pe.toString("latin1", 0, 4) === "PE\0\0")
        return { format: "PE", machine: pe.readUInt16LE(4) };
    }
    return {};
  } finally {
    await file.close();
  }
}

// mac-arm64/Blame.app/Contents/Resources, win-unpacked/resources, linux-unpacked/resources
function packagedPlatform(archive) {
  const resources = dirname(archive);
  if (resources.split(sep).join("/").endsWith(".app/Contents/Resources")) return "darwin";
  return basename(dirname(resources)).startsWith("win-") ? "win32" : "linux";
}

/** Run after electron-builder, before installers can be copied or uploaded. */
export async function verifyPackagedWorkspaceRuntime(dist) {
  const archives = [];
  async function walk(directory, depth = 0) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === "app.asar") archives.push(path);
      else if (entry.isDirectory() && entry.name.endsWith(".app")) {
        archives.push(join(path, "Contents/Resources/app.asar"));
      } else if (
        entry.isDirectory() &&
        depth < 2 &&
        !["runtime", "node_modules", "app.asar.unpacked"].includes(entry.name)
      ) {
        await walk(path, depth + 1);
      }
    }
  }
  await walk(dist);
  if (!archives.length)
    throw new Error(`No packaged app.asar found in ${dist}`);
  for (const archive of archives) {
    const generatedFiles = verifyAsarGeneratedJavaScript(archive);
    const count = await verifyAsarWorkspaceRuntime(archive);
    const compilers = verifyAsarTypeScriptLibraries(archive);
    await verifyUnpackedNpm(archive);
    await verifyUnpackedAgentBrowser(archive);
    const engineTargets = await verifyPackagedEngineBinaries(dirname(archive), packagedPlatform(archive));
    const manifest = JSON.parse(asarTools().extractFile(archive, "package.json").toString("utf8"));
    if (archive.split(sep).join("/").endsWith(".app/Contents/Resources/app.asar") && manifest.dependencies?.["node-pty"]) {
      await verifyNodePtyHelpers(join(`${archive}.unpacked`, "node_modules/node-pty"));
    }
    console.log(
      `Verified ${generatedFiles} generated files, ${count} workspace packages, the default libraries of ${compilers} TypeScript compiler(s) and the ${engineTargets.join(" and ")} engine binaries in ${archive}`,
    );
  }
}
