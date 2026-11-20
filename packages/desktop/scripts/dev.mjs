#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveLimaBundle } from "../../../scripts/lima-runtime-bundle.mjs"
import { prepareNodePtyHelpers } from "./prepare-node-pty.mjs"

const forceKillDelayMs = 2_000
const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)))
await prepareNodePtyHelpers()
buildEngine()
const runtimeEnvironment =
  process.platform === "darwin"
    ? await macosRuntimeEnvironment()
    : process.platform === "win32"
      ? {
          BLAME_RUNTIME_BIN_DIR:
            process.env.BLAME_RUNTIME_BIN_DIR ??
            join(desktopDir, "resources", "runtime", "windows", "bin"),
          BLAME_RUNTIME_SCRIPT_DIR:
            process.env.BLAME_RUNTIME_SCRIPT_DIR ??
            join(desktopDir, "resources", "runtime", "windows", "scripts"),
        }
      : {}
const child = spawn("pnpm", ["exec", "electron-vite", "dev"], {
  detached: process.platform !== "win32",
  env: { ...process.env, ...runtimeEnvironment },
  stdio: "inherit",
})

// The app runs agents on the checkout's Cargo builds of blame-engine and its
// workspace harness, blame-harness (src/main/engine/engine-binary.ts): build
// them, so a fresh checkout works and they always match the sources. A
// failed build keeps the last one.
function buildEngine() {
  if (process.env.BLAME_ENGINE_BIN?.trim()) return
  const result = spawnSync("cargo", ["build", "-p", "blame-engine", "-p", "blame-harness"], {
    cwd: join(desktopDir, "..", ".."),
    shell: process.platform === "win32",
    stdio: "inherit",
  })
  if (result.status !== 0)
    console.warn(
      result.error
        ? "cargo is not installed: install Rust (rustup.rs) for Blame's agent engine, or set BLAME_ENGINE_BIN."
        : "blame-engine or blame-harness did not build: the app keeps the last build, if any.",
    )
}

async function macosRuntimeEnvironment() {
  const manifest = JSON.parse(
    await readFile(
      join(desktopDir, "resources", "runtime", "macos", "manifest.json"),
      "utf8",
    ),
  )
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64"
  const bundleDir = await resolveLimaBundle(manifest, "darwin", architecture)
  return {
    BLAME_LIMA_BUNDLE_DIR: bundleDir,
    BLAME_RUNTIME_BIN_DIR:
      process.env.BLAME_RUNTIME_BIN_DIR ??
      join(desktopDir, "resources", "runtime", "macos", "bin"),
  }
}

let stopping = false
let childExited = false

child.on("error", (error) => {
  console.error(error.message)
  process.exit(1)
})

child.on("exit", (code, signal) => {
  childExited = true
  if (stopping) process.exit(0)
  if (signal) process.exit(1)
  process.exit(code ?? 0)
})

process.once("SIGINT", () => stopChildProcess("SIGINT"))
process.once("SIGTERM", () => stopChildProcess("SIGTERM"))
process.once("SIGHUP", () => stopChildProcess("SIGHUP"))
process.on("exit", () => {
  if (!childExited) killChildProcess("SIGTERM")
})

function stopChildProcess(signal) {
  if (stopping) return
  stopping = true
  killChildProcess(signal)
  setTimeout(() => {
    killChildProcess("SIGKILL")
    process.exit(0)
  }, forceKillDelayMs).unref()
}

function killChildProcess(signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  child.kill(signal)
}
