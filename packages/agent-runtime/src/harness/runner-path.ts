// How the engine starts the workspace harness, `blame-harness serve`
// (crates/blame-harness), from this package: the Node files it still uses
// sit next to this module. It imports nothing heavy: the main process loads
// it.
//
// - the compiler side process (`rust-harness-compiler.js`), run by `node`:
//   the TypeScript compiler, the import index, content validation and the
//   symbolic analysis;
// - the Node test reporter and the Vitest preload hook it adds to owned test
//   invocations (BLAME_HARNESS_NODE_ASSETS), run by the project's own Node:
//   real files, so in a packaged app the unpacked copies;
// - the bundled package managers (BLAME_HARNESS_NODE_MODULES);
// - the bundled ripgrep, put on the commands' PATH.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A packaged app's files that non-Electron processes read: the unpacked copies. */
export function unpackedPath(path: string) {
  return path.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
}

const here = dirname(fileURLToPath(import.meta.url));

/** The compiler side process's entry. */
export function harnessCompilerPath() {
  return join(here, "rust-harness-compiler.js");
}

/** `blame-harness serve`, answering the app's questions (credentials, preview refresh). */
export function harnessServeArgs() {
  return ["serve", "--asks"];
}

/**
 * The environment the harness needs from this package. `node` runs the
 * compiler side process: Electron itself in the app, with
 * ELECTRON_RUN_AS_NODE set by the caller.
 */
export function harnessEnvironment(node: string): Record<string, string> {
  const environment: Record<string, string> = {
    BLAME_HARNESS_COMPILER: JSON.stringify([node, harnessCompilerPath()]),
    BLAME_HARNESS_NODE_ASSETS: unpackedPath(here),
  };
  const modules = packageManagerModules();
  if (modules) environment.BLAME_HARNESS_NODE_MODULES = modules;
  const ripgrep = ripgrepDirectory();
  if (ripgrep) environment.BLAME_HARNESS_RIPGREP_DIRECTORY = ripgrep;
  return environment;
}

/** The nearest node_modules that holds the bundled npm, unpacked. */
function packageManagerModules() {
  for (let directory = here; ; directory = dirname(directory)) {
    const modules = unpackedPath(join(directory, "node_modules"));
    if (existsSync(join(modules, "npm", "package.json"))) return modules;
    if (dirname(directory) === directory) return undefined;
  }
}

function ripgrepDirectory() {
  try {
    const { rgPath } = createRequire(import.meta.url)("@vscode/ripgrep") as { rgPath: string };
    return dirname(unpackedPath(rgPath));
  } catch {
    return undefined;
  }
}
