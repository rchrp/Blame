import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSync } from "vite";

// The main process does not load the agent runtime: its entry pulls the
// whole engine, Cline SDK included, which only the engine host needs
// (engine-host-process.js, a separate entry it is forked from). With
// it, the main process held 262 MB instead of 90 on the backlog and showed
// its window 0.56 s later (measured 2026-11-19, main-process-bench.mjs). The main process uses the
// runtime's targeted entries, whose modules import nothing from npm but the
// few light packages listed here. This follows every static and dynamic
// import the built main entry can load, through workspace packages, and
// fails on the runtime's main entry or on any other npm package a runtime
// module imports. The preload is sandboxed: it can load no package.
const runtimePackage = "@blame/agent-runtime";
const lightRuntimeDependencies = new Set(["ipaddr.js"]);

export async function checkMainProcessImports(output) {
  const entry = resolve(output, "main/index.js");
  const runtimeEntry = createRequire(entry).resolve(runtimePackage);
  const packages = new PackageNames();
  const failures = [];
  const visited = new Set();
  const queue = [entry];
  while (queue.length) {
    const path = queue.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const importer = await packages.of(path);
    const at = relative(process.cwd(), path);
    const source = await readFile(path, "utf8");
    for (const specifier of importedSpecifiers(source, at, failures)) {
      if (builtin(specifier)) continue;
      const name = packageName(specifier);
      if (!name)
        queue.push(fileURLToPath(new URL(specifier, pathToFileURL(path))));
      else if (name.startsWith("@blame/")) {
        const target = createRequire(path).resolve(specifier);
        if (target === runtimeEntry)
          failures.push(
            `${at} imports ${specifier}, the agent runtime's whole engine`,
          );
        else queue.push(target);
      } else if (
        importer === runtimePackage &&
        !lightRuntimeDependencies.has(name)
      )
        failures.push(
          `${at} imports ${specifier}, a dependency of the agent engine`,
        );
    }
  }
  if (failures.length)
    throw new Error(
      `The main process must not load the agent runtime:\n${failures.join("\n")}`,
    );
  return visited.size;
}

function importedSpecifiers(source, path, failures) {
  const { errors, module } = parseSync(path, source, { sourceType: "module" });
  if (errors.length)
    throw new Error(`Cannot parse ${path}: ${errors[0].message}`);
  const specifiers = [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((item) =>
        item.moduleRequest ? [item.moduleRequest.value] : [],
      ),
    ),
  ];
  for (const { moduleRequest } of module.dynamicImports) {
    const literal = /^(["'`])([^"'`$]+)\1$/.exec(
      source.slice(moduleRequest.start, moduleRequest.end),
    );
    if (literal) specifiers.push(literal[2]);
    else
      failures.push(
        `${path} imports a computed module path, which cannot be checked`,
      );
  }
  return specifiers;
}

// The npm package a bare specifier names; none for a path.
function packageName(specifier) {
  if (/^(\.{1,2}\/|\/|file:)/.test(specifier)) return undefined;
  const [scope, name] = specifier.split("/");
  return scope.startsWith("@") ? `${scope}/${name}` : scope;
}

function builtin(specifier) {
  return (
    specifier.startsWith("node:") ||
    builtinModules.includes(specifier) ||
    specifier === "electron" ||
    specifier.startsWith("electron/")
  );
}

// The name in the package.json nearest a file.
class PackageNames {
  directories = new Map();

  async of(path) {
    return this.directoryName(dirname(path));
  }

  async directoryName(directory) {
    if (!this.directories.has(directory))
      this.directories.set(directory, this.readName(directory));
    return this.directories.get(directory);
  }

  async readName(directory) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (manifest.name) return manifest.name;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    return parent === directory ? undefined : this.directoryName(parent);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modules = await checkMainProcessImports(
    resolve(import.meta.dirname, "../out"),
  );
  console.log(
    `Verified that the ${modules} modules the main process can load leave out the agent engine`,
  );
}
