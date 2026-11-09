import assert from "node:assert/strict"
import test from "node:test"

import {
  autoStartTipVisible,
  storyPreviewStartsAutomatically,
} from "./story-preview-auto-start-decision.ts"

test("starts nothing by itself while the setting is off", () => {
  for (const workspaceMode of ["local-container", "cloud-mirror"]) {
    assert.equal(
      storyPreviewStartsAutomatically(
        { workspaceMode, runConfigurationId: "web" },
        false
      ),
      false
    )
  }
})

test("starts local container and cloud previews once the setting is on", () => {
  for (const workspaceMode of ["local-container", "cloud-mirror"]) {
    assert.equal(
      storyPreviewStartsAutomatically(
        { workspaceMode, runConfigurationId: "web" },
        true
      ),
      true
    )
  }
})

test("a story without a chosen service yet still starts its default one", () => {
  assert.equal(
    storyPreviewStartsAutomatically({ workspaceMode: "local-container" }, true),
    true
  )
})

test("a story whose run configuration is none starts nothing", () => {
  assert.equal(
    storyPreviewStartsAutomatically(
      { workspaceMode: "local-container", runConfigurationId: null },
      true
    ),
    false
  )
})

test("direct stories and stories without a mode never start a preview", () => {
  for (const workspaceMode of ["direct", null, undefined]) {
    assert.equal(
      storyPreviewStartsAutomatically({ workspaceMode }, true),
      false
    )
  }
})

test("tells that previews do not start by themselves while the setting is off", () => {
  for (const workspaceMode of ["local-container", "cloud-mirror"]) {
    assert.equal(
      autoStartTipVisible({
        autoStartEnabled: false,
        projectRunMode: false,
        workspaceMode,
      }),
      true
    )
  }
})

test("drops the tip as soon as the setting is on", () => {
  assert.equal(
    autoStartTipVisible({
      autoStartEnabled: true,
      projectRunMode: false,
      workspaceMode: "local-container",
    }),
    false
  )
})

test("no tip for the project's app or for direct stories", () => {
  assert.equal(
    autoStartTipVisible({
      autoStartEnabled: false,
      projectRunMode: true,
      workspaceMode: "local-container",
    }),
    false
  )
  for (const workspaceMode of ["direct", null, undefined]) {
    assert.equal(
      autoStartTipVisible({
        autoStartEnabled: false,
        projectRunMode: false,
        workspaceMode,
      }),
      false
    )
  }
})
