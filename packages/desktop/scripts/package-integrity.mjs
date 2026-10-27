import { access, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, normalize, posix, relative, sep } from "node:path";
import { checkJavaScript } from "./check-generated-javascript.mjs";

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
    console.log(
      `Verified ${generatedFiles} generated files, ${count} workspace packages and the default libraries of ${compilers} TypeScript compiler(s) in ${archive}`,
    );
  }
}
