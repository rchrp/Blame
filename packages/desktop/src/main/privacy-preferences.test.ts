import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPrivacyPreferences,
  parsePrivacyPreferences,
  savePrivacyPreferences,
} from "./privacy-preferences.ts";

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "blame-privacy-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("telemetry and update checks are on until the user turns them off", () => {
  withDirectory((directory) => {
    assert.deepEqual(loadPrivacyPreferences(directory), {
      telemetry: true,
      updateChecks: true,
    });
    savePrivacyPreferences(directory, { telemetry: false, updateChecks: true });
    assert.deepEqual(loadPrivacyPreferences(directory), {
      telemetry: false,
      updateChecks: true,
    });
  });
});

test("the installer's choices only turn things off, once", () => {
  withDirectory((directory) => {
    savePrivacyPreferences(directory, { telemetry: false, updateChecks: true });
    const choices = join(directory, "installer-privacy-choices.json");
    writeFileSync(choices, '{"telemetry":true,"updateChecks":false}');

    assert.deepEqual(loadPrivacyPreferences(directory), {
      telemetry: false,
      updateChecks: false,
    });
    assert.equal(existsSync(choices), false);
    const saved = JSON.parse(
      readFileSync(join(directory, "privacy-preferences.json"), "utf8"),
    );
    assert.deepEqual(saved, { telemetry: false, updateChecks: false });
  });
});

test("unreadable files fall back to the defaults", () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, "privacy-preferences.json"), "{");
    writeFileSync(
      join(directory, "installer-privacy-choices.json"),
      '{"telemetry":"no"}',
    );
    assert.deepEqual(loadPrivacyPreferences(directory), {
      telemetry: true,
      updateChecks: true,
    });
  });
});

test("Settings must send both preferences as booleans", () => {
  assert.deepEqual(
    parsePrivacyPreferences({ telemetry: false, updateChecks: true, extra: 1 }),
    {
      telemetry: false,
      updateChecks: true,
    },
  );
  assert.throws(() =>
    parsePrivacyPreferences({ telemetry: "false", updateChecks: true }),
  );
});
