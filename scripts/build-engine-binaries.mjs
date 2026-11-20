// Builds the Rust binaries the desktop app ships (docs/engine-in-the-app.md,
// "Engine binaries"): blame-engine and blame-harness, release profile, into
// target/engine-binaries/<platform>-<arch>/, the layout of the app's
// resources/engine. Linux targets are static musl builds made with
// cargo-zigbuild: the same files run on a Linux desktop and in any runtime VM.
// Local packaging (packages/desktop/scripts/package.mjs) and the release
// workflow both build through this script.
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoTargetDir = resolve(
  rootDir,
  process.env.CARGO_TARGET_DIR?.trim() || "target",
);
export const defaultEngineBinariesDir = join(cargoTargetDir, "engine-binaries");

const both = ["blame-engine", "blame-harness"];

/** Every target, named `<process.platform>-<process.arch>` as the app names them. */
export const engineTargets = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", builds: ["darwin"] },
  "darwin-x64": { triple: "x86_64-apple-darwin", builds: ["darwin"] },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", builds: ["win32"] },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    builds: ["darwin", "linux"],
    zig: true,
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    builds: ["darwin", "linux"],
    zig: true,
  },
};

export function engineExecutables(target) {
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  return both.map((name) => `${name}${suffix}`);
}

/**
 * What one package carries: the binaries for the app's own platform and the
 * Linux ones its runtime VM (Lima, WSL) runs, of the same architecture. On
 * Linux both are the same directory.
 */
export function packagedEngineTargets(platform, arch) {
  return [...new Set([`${platform}-${arch}`, `linux-${arch}`])];
}

/** Builds `targets` and copies their binaries to `<outDir>/<target>/`. */
export async function buildEngineBinaries(
  targets,
  { outDir = defaultEngineBinariesDir } = {},
) {
  const built = [];
  for (const target of targets) {
    const spec = engineTargets[target];
    if (!spec) throw new Error(`Unknown engine target ${target}`);
    if (!spec.builds.includes(process.platform))
      throw new Error(
        `The ${target} engine binaries are built on ${spec.builds.join(" or ")}, not ${process.platform}.`,
      );
    await run("rustup", ["target", "add", spec.triple]);
    await run("cargo", [
      ...(spec.zig ? ["zigbuild"] : ["build"]),
      "--release",
      "--locked",
      "--target",
      spec.triple,
      ...both.flatMap((name) => ["-p", name]),
    ]);
    const directory = join(outDir, target);
    await mkdir(directory, { recursive: true });
    const files = [];
    for (const executable of engineExecutables(target)) {
      const destination = join(directory, executable);
      await copyFile(
        join(cargoTargetDir, spec.triple, "release", executable),
        destination,
      );
      await chmod(destination, 0o755);
      files.push({ path: destination, bytes: (await stat(destination)).size });
    }
    built.push({ target, files });
  }
  return built;
}

/**
 * Copies the binaries one package carries into `resourcesDir` (the staged
 * app's resources/engine). Without `prebuiltDir` it builds them first, so a
 * local package never ships a stale engine; the release workflow passes the
 * binaries its engine jobs built.
 */
export async function stageEngineBinaries(
  resourcesDir,
  { platform, arch, prebuiltDir },
) {
  const targets = packagedEngineTargets(platform, arch);
  if (!prebuiltDir) await buildEngineBinaries(targets);
  const source = prebuiltDir ?? defaultEngineBinariesDir;
  const staged = [];
  for (const target of targets) {
    await mkdir(join(resourcesDir, target), { recursive: true });
    for (const executable of engineExecutables(target)) {
      const from = join(source, target, executable);
      const to = join(resourcesDir, target, executable);
      await copyFile(from, to).catch((error) => {
        throw new Error(
          `No ${target} ${executable} in ${source}: build it with \`node scripts/build-engine-binaries.mjs ${target}\`.`,
          { cause: error },
        );
      });
      await chmod(to, 0o755);
      staged.push({ path: to, bytes: (await stat(to)).size });
    }
  }
  return staged;
}

export function formatSizes(files) {
  return files
    .map(
      ({ path, bytes }) =>
        `${(bytes / 1048576).toFixed(1).padStart(6)} MiB  ${path}`,
    )
    .join("\n");
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(
            new Error(`${command} ${args.join(" ")} exited with ${code}`),
          ),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      [
        "Usage: node scripts/build-engine-binaries.mjs [target... | all] [--out <dir>]",
        "",
        `Targets: ${Object.keys(engineTargets).join(", ")}.`,
        "Without a target: what a package for this machine carries",
        `(${packagedEngineTargets(process.platform, process.arch).join(", ")}).`,
        "Linux targets need cargo-zigbuild and zig on PATH.",
      ].join("\n"),
    );
    process.exit(0);
  }
  const out = args.indexOf("--out");
  const outDir = out === -1 ? undefined : resolve(args[out + 1]);
  const named =
    out === -1
      ? args
      : args.filter((_, index) => index !== out && index !== out + 1);
  const targets = named.includes("all")
    ? Object.keys(engineTargets).filter((target) =>
        engineTargets[target].builds.includes(process.platform),
      )
    : named.length
      ? named
      : packagedEngineTargets(process.platform, process.arch);
  const built = await buildEngineBinaries(targets, { outDir });
  console.log(formatSizes(built.flatMap((target) => target.files)));
}
