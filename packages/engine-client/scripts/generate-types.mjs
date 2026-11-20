// Regenerates src/generated/protocol.ts from the Rust protocol crate, or with
// --check fails when the committed file is out of date.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const target = join(packageRoot, "src", "generated", "protocol.ts");

// rustup installs cargo under ~/.cargo/bin, which a non-login shell may lack.
const env = {
  ...process.env,
  PATH: [process.env.PATH, join(homedir(), ".cargo", "bin")].join(delimiter),
};

const cargo = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "blame-engine-protocol",
    "--features",
    "ts",
    "--example",
    "typescript",
  ],
  { cwd: repositoryRoot, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 },
);
if (cargo.error || cargo.status !== 0) {
  console.error(cargo.stderr || cargo.error?.message || "cargo failed");
  process.exit(1);
}

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    // A missing file is as stale as a different one.
  }
  if (committed !== cargo.stdout) {
    console.error(
      "src/generated/protocol.ts is out of date: run `pnpm --filter @blame/engine-client generate`",
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, cargo.stdout);
  console.log(`wrote ${target}`);
}
