import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PreviewDevtoolsSettings } from "./preview-devtools-settings.ts";

test("advanced diagnostics are off by default and kept per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-devtools-settings-"));
  try {
    const file = join(root, "settings.json");
    const settings = new PreviewDevtoolsSettings(file);
    assert.equal(await settings.advancedDiagnostics("project-a"), false);
    assert.equal(await settings.advancedDiagnostics(undefined), false);
    await settings.setAdvancedDiagnostics("project-a", true);
    assert.equal(await settings.advancedDiagnostics("project-a"), true);
    assert.equal(await settings.advancedDiagnostics("project-b"), false);
    const reloaded = new PreviewDevtoolsSettings(file);
    assert.equal(await reloaded.advancedDiagnostics("project-a"), true);
    await reloaded.setAdvancedDiagnostics("project-a", false);
    assert.equal(
      await new PreviewDevtoolsSettings(file).advancedDiagnostics("project-a"),
      false,
    );
    await assert.rejects(
      settings.setAdvancedDiagnostics("../x", true),
      /Invalid project id/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
