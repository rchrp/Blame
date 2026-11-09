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

test("update checks are on until the user turns them off", () => {
  withDirectory((directory) => {
    assert.deepEqual(loadPrivacyPreferences(directory), { updateChecks: true });
    savePrivacyPreferences(directory, { updateChecks: false });
    assert.deepEqual(loadPrivacyPreferences(directory), {
      updateChecks: false,
    });
  });
});

test("keys the app does not know are ignored", () => {
  withDirectory((directory) => {
    writeFileSync(
      join(directory, "privacy-preferences.json"),
      '{"updateChecks":false,"unknown":true}',
    );
    assert.deepEqual(loadPrivacyPreferences(directory), {
      updateChecks: false,
    });
  });
});

test("the installer's choices only turn things off, once", () => {
  withDirectory((directory) => {
    savePrivacyPreferences(directory, { updateChecks: false });
    const choices = join(directory, "installer-privacy-choices.json");
    writeFileSync(choices, '{"updateChecks":true}');

    assert.deepEqual(loadPrivacyPreferences(directory), {
      updateChecks: false,
    });
    assert.equal(existsSync(choices), false);

    writeFileSync(choices, '{"updateChecks":false}');
    savePrivacyPreferences(directory, { updateChecks: true });
    assert.deepEqual(loadPrivacyPreferences(directory), {
      updateChecks: false,
    });
    const saved = JSON.parse(
      readFileSync(join(directory, "privacy-preferences.json"), "utf8"),
    );
    assert.deepEqual(saved, { updateChecks: false });
  });
});

test("unreadable files fall back to the defaults", () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, "privacy-preferences.json"), "{");
    writeFileSync(
      join(directory, "installer-privacy-choices.json"),
      '{"updateChecks":"no"}',
    );
    assert.deepEqual(loadPrivacyPreferences(directory), { updateChecks: true });
  });
});

test("Settings must send the preference as a boolean", () => {
  assert.deepEqual(parsePrivacyPreferences({ updateChecks: true, extra: 1 }), {
    updateChecks: true,
  });
  assert.throws(() => parsePrivacyPreferences({ updateChecks: "false" }));
});
