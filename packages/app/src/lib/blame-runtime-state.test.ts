import assert from "node:assert/strict"
import test from "node:test"

import {
  automaticRuntimeOperation,
  runtimeBlocksNewRuns,
  runtimePhaseFromReport,
  runtimeProgressText,
} from "./blame-runtime-state.ts"

const report = (
  status: "ready" | "missing" | "repairable" | "unsupported" | "broken",
  updateRequired = false
) => ({ issues: [], platform: "darwin", runtime: "BlameRuntime", status, updateRequired })

test("reads the runtime report as one phase", () => {
  assert.equal(runtimePhaseFromReport(report("ready")), "ready")
  assert.equal(runtimePhaseFromReport(report("missing")), "missing")
  assert.equal(runtimePhaseFromReport(report("repairable", true)), "update-pending")
  assert.equal(runtimePhaseFromReport(report("repairable")), "needs-repair")
  assert.equal(runtimePhaseFromReport(report("broken")), "needs-repair")
  assert.equal(runtimePhaseFromReport(report("unsupported")), "unsupported")
})

test("updates only once no local story is running", () => {
  const base = { autoRepairTried: false, canInstall: true }
  assert.equal(
    automaticRuntimeOperation({ ...base, localRunsActive: 2, phase: "update-pending" }),
    undefined
  )
  assert.equal(
    automaticRuntimeOperation({ ...base, localRunsActive: 0, phase: "update-pending" }),
    "update"
  )
})

test("repairs on its own once, and never installs without asking", () => {
  const base = { canInstall: true, localRunsActive: 0 }
  assert.equal(
    automaticRuntimeOperation({ ...base, autoRepairTried: false, phase: "needs-repair" }),
    "repair"
  )
  assert.equal(
    automaticRuntimeOperation({ ...base, autoRepairTried: true, phase: "needs-repair" }),
    undefined
  )
  assert.equal(
    automaticRuntimeOperation({ ...base, autoRepairTried: false, phase: "missing" }),
    undefined
  )
  assert.equal(
    automaticRuntimeOperation({
      autoRepairTried: false,
      canInstall: false,
      localRunsActive: 0,
      phase: "update-pending",
    }),
    undefined
  )
})

test("holds new local stories while the runtime is busy", () => {
  assert.equal(runtimeBlocksNewRuns("updating"), true)
  assert.equal(runtimeBlocksNewRuns("update-pending"), true)
  assert.equal(runtimeBlocksNewRuns("ready"), false)
  assert.equal(runtimeBlocksNewRuns("missing"), false)
})

test("describes progress in plain words", () => {
  assert.equal(runtimeProgressText({ phase: "downloading", percent: 41.6 }), "Downloading 42%")
  assert.equal(runtimeProgressText({ phase: "starting" }), "Starting…")
  assert.equal(runtimeProgressText(undefined), "Getting ready…")
})
