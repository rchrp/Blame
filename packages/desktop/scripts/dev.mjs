#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveLimaBundle } from "../../../scripts/lima-runtime-bundle.mjs"
import { prepareNodePtyHelpers } from "./prepare-node-pty.mjs"

const forceKillDelayMs = 2_000
const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)))
await prepareNodePtyHelpers()
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
