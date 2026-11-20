import { statSync } from "node:fs";
import { join, resolve } from "node:path";

// The one place that finds the Rust binaries (docs/engine-in-the-app.md,
// "Engine binaries"). A variable wins; a packaged app then has them in
// resources/engine/<platform>-<arch>/; in development they are the newest
// Cargo build of this checkout (release or debug: `pnpm dev` builds debug).

export type BinaryLookup = { path: string } | { missing: string };

type Lookup = {
  /** `app.getAppPath()`: packages/desktop in development. */
  applicationPath: string;
  /** `process.resourcesPath`. */
  resourcesPath: string;
  /** `app.isPackaged`. */
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
  /** When the file was last modified (ms), undefined when there is none. */
  modified?: (path: string) => number | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
};

const binaries = {
  engine: {
    name: "blame-engine",
    title: "agent engine",
    variable: "BLAME_ENGINE_BIN",
  },
  harness: {
    name: "blame-harness",
    title: "code harness",
    variable: "BLAME_HARNESS_BIN",
  },
} as const;

export function engineBinary(input: Lookup): BinaryLookup {
  return findBinary(binaries.engine, input);
}

export function harnessBinary(input: Lookup): BinaryLookup {
  return findBinary(binaries.harness, input);
}

/**
 * The Linux binaries the runtime VM (Lima, WSL) runs, for its architecture:
 * static builds the app copies into the VM. In development they come from
 * `node scripts/build-engine-binaries.mjs linux-<arch>`.
 */
export function vmEngineBinaries(
  input: Omit<Lookup, "env" | "platform" | "arch"> & { arch: "arm64" | "x64" },
): { engine: string; harness: string } | { missing: string } {
  const exists = existence(input.modified);
  const target = `linux-${input.arch}`;
  const directory = input.packaged
    ? join(input.resourcesPath, "engine", target)
    : join(
        checkout(input.applicationPath),
        "target",
        "engine-binaries",
        target,
      );
  const engine = join(directory, binaries.engine.name);
  const harness = join(directory, binaries.harness.name);
  if (exists(engine) && exists(harness)) return { engine, harness };
  return {
    missing: input.packaged
      ? `Blame's ${target} engine binaries are missing from this installation (${directory}): reinstall Blame.`
      : `No ${target} engine binaries in ${directory}: build them with \`node scripts/build-engine-binaries.mjs ${target}\`.`,
  };
}

function findBinary(
  binary: (typeof binaries)[keyof typeof binaries],
  input: Lookup,
): BinaryLookup {
  const env = input.env ?? process.env;
  const modified = input.modified ?? modifiedAt;
  const exists = existence(modified);
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const executable = platform === "win32" ? `${binary.name}.exe` : binary.name;
  const configured = env[binary.variable]?.trim();
  if (configured)
    return exists(configured)
      ? { path: configured }
      : {
          missing: `${binary.variable} points at ${configured}, which does not exist.`,
        };
  const candidates = input.packaged
    ? [join(input.resourcesPath, "engine", `${platform}-${arch}`, executable)]
    : ["release", "debug"].map((profile) =>
        join(checkout(input.applicationPath), "target", profile, executable),
      );
  const path = candidates
    .filter(exists)
    .sort((a, b) => (modified(b) ?? 0) - (modified(a) ?? 0))[0];
  if (path) return { path };
  return {
    missing: input.packaged
      ? `Blame's ${binary.title} is missing from this installation (${candidates[0]}): reinstall Blame.`
      : `Blame's ${binary.title} is not built: run \`cargo build -p ${binary.name}\`, or set ${binary.variable}.`,
  };
}

function modifiedAt(path: string) {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs;
}

function existence(modified = modifiedAt) {
  return (path: string) => modified(path) !== undefined;
}

// The desktop package sits at packages/desktop in the repository.
function checkout(applicationPath: string) {
  return resolve(applicationPath, "../..");
}
