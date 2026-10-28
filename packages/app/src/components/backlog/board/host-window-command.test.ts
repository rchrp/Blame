import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { foregroundHostWindowCommand } from "./host-window-command.ts"
import { isHostWindowConfiguration } from "../drawer/surfaces/host-window-kind.ts"
import { projectPreviewConfiguration } from "./project-run-configuration.ts"

test("host app commands preserve arguments and report their process exit", () => {
  if (process.platform === "win32") return
  const result = spawnSync(
    "sh",
    [
      "-c",
      foregroundHostWindowCommand(
        "printf '%s' \"it's literal\"; exit 7",
        "linux"
      ),
    ],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 7)
  assert.equal(result.stdout, "it's literal")
})
test("host-only desktop previews are selected after web previews", () => {
  const desktop = {
    id: "desktop",
    name: "Desktop",
    command: "swift run",
    cwd: ".",
    default: true,
    category: "desktop" as const,
    services: [],
    scopes: ["desktop"],
  }
  const web = {
    ...desktop,
    id: "web",
    default: false,
    category: "web" as const,
    services: ["web"],
    previewService: "web",
    previewUrl: "http://localhost:3000",
  }
  assert.equal(isHostWindowConfiguration(desktop), true)
  assert.equal(projectPreviewConfiguration([desktop])?.id, "desktop")
  assert.equal(projectPreviewConfiguration([desktop, web])?.id, "web")
})
