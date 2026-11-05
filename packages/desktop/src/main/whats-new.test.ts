import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  currentReleaseNotes,
  launchWhatsNew,
  markWhatsNewSeen,
  readWhatsNewState,
  whatsNewToShow,
  withReleaseNotes,
  writeWhatsNewState,
  type WhatsNewState,
} from "./whats-new.ts";

const notes = (version: string) => ({
  notes: `## What's Changed\n- Notes of ${version}`,
  releaseDate: "2026-11-01T00:00:00.000Z",
  version,
});

function updatedTo(version: string, from = "1.2.0"): WhatsNewState {
  return withReleaseNotes(
    launchWhatsNew({ notes: [], version: from }, version),
    notes(version),
  );
}

test("shows the notes once after an update to a new version", () => {
  const state = updatedTo("1.3.0");
  assert.deepEqual(whatsNewToShow(state, true), notes("1.3.0"));

  const seen = markWhatsNewSeen(state, "1.3.0");
  assert.equal(whatsNewToShow(seen, true), undefined);
  assert.equal(whatsNewToShow(launchWhatsNew(seen, "1.3.0"), true), undefined);
  // Settings → Desktop can still show them.
  assert.deepEqual(currentReleaseNotes(seen), notes("1.3.0"));
});

test("shows nothing when the same version launches again", () => {
  const state = withReleaseNotes(
    launchWhatsNew({ notes: [], version: "1.3.0" }, "1.3.0"),
    notes("1.3.0"),
  );
  assert.equal(whatsNewToShow(state, true), undefined);
});

test("a fresh install shows nothing", () => {
  const state = withReleaseNotes(launchWhatsNew(undefined, "1.3.0"), notes("1.3.0"));
  assert.equal(whatsNewToShow(state, true), undefined);
  assert.deepEqual(currentReleaseNotes(state), notes("1.3.0"));
});

test("shows nothing while update checks are off", () => {
  assert.equal(whatsNewToShow(updatedTo("1.3.0"), false), undefined);
});

test("a downgrade shows nothing", () => {
  assert.equal(whatsNewToShow(updatedTo("1.2.0", "1.3.0"), true), undefined);
});

test("notes that arrive on a later launch are still shown once", () => {
  const offline = launchWhatsNew({ notes: [], version: "1.2.0" }, "1.3.0");
  assert.equal(whatsNewToShow(offline, true), undefined);

  const relaunched = withReleaseNotes(launchWhatsNew(offline, "1.3.0"), notes("1.3.0"));
  assert.deepEqual(whatsNewToShow(relaunched, true), notes("1.3.0"));
});

test("keeps the notes of a downloaded update for its first launch", () => {
  const running = launchWhatsNew({ notes: [], version: "1.2.0" }, "1.2.0");
  const downloaded = withReleaseNotes(
    withReleaseNotes(running, notes("1.2.0")),
    notes("1.3.0"),
  );
  assert.deepEqual(currentReleaseNotes(downloaded), notes("1.2.0"));

  const updated = launchWhatsNew(downloaded, "1.3.0");
  assert.deepEqual(updated.notes, [notes("1.3.0")]);
  assert.deepEqual(whatsNewToShow(updated, true), notes("1.3.0"));
});

test("ignores empty notes and notes of older versions", () => {
  const state = launchWhatsNew({ notes: [], version: "1.3.0" }, "1.3.0");
  assert.deepEqual(withReleaseNotes(state, { notes: "  ", version: "1.3.0" }).notes, []);
  assert.deepEqual(withReleaseNotes(state, notes("1.2.0")).notes, []);
});

test("dismissing another version keeps the notes unseen", () => {
  const state = updatedTo("1.3.0");
  assert.deepEqual(whatsNewToShow(markWhatsNewSeen(state, "1.2.0"), true), notes("1.3.0"));
});

test("persists the state and treats a missing or invalid file as a fresh install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-whats-new-"));
  const file = join(directory, "nested", "whats-new.json");
  try {
    assert.equal(await readWhatsNewState(file), undefined);

    const state = updatedTo("1.3.0");
    await writeWhatsNewState(file, state);
    assert.deepEqual(await readWhatsNewState(file), state);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), state);

    await writeFile(file, '{"version":1}');
    assert.equal(await readWhatsNewState(file), undefined);

    await writeFile(
      file,
      JSON.stringify({ version: "1.3.0", notes: [{ version: "1.3.0" }, notes("1.3.0")] }),
    );
    assert.deepEqual(await readWhatsNewState(file), {
      notes: [notes("1.3.0")],
      version: "1.3.0",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
