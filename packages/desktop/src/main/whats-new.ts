import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareVersions } from "./desktop-update-channel.ts";

// The notes of one version, as its update metadata (latest*.yml) carries them.
export type ReleaseNotes = {
  notes: string;
  releaseDate?: string;
  version: string;
};

// What each installation remembers to show a version's notes once, after an
// update. The notes come from update checks and downloads, so showing them
// later needs no request of its own.
export type WhatsNewState = {
  // The version that ran last.
  version: string;
  // The version Blame updated to, until its notes have been shown.
  unseen?: string;
  // The notes of the running version and of a downloaded update.
  notes: ReleaseNotes[];
};

/**
 * The state of this launch. Without a saved state Blame never ran here: a
 * fresh install has nothing new to show.
 */
export function launchWhatsNew(
  saved: WhatsNewState | undefined,
  version: string,
): WhatsNewState {
  if (!saved) return { notes: [], version };
  const updated = isNewerVersion(version, saved.version);
  return {
    notes: saved.notes.filter(
      (entry) =>
        entry.version === version || isNewerVersion(entry.version, version),
    ),
    unseen: updated || saved.unseen === version ? version : undefined,
    version,
  };
}

/** The notes to show at launch, once. Nothing while update checks are off. */
export function whatsNewToShow(state: WhatsNewState, updateChecks: boolean) {
  if (!updateChecks || state.unseen !== state.version) return undefined;
  return currentReleaseNotes(state);
}

export function currentReleaseNotes(state: WhatsNewState) {
  return state.notes.find((entry) => entry.version === state.version);
}

/** Keeps the notes of the running version and of the newest update. */
export function withReleaseNotes(
  state: WhatsNewState,
  notes: ReleaseNotes,
): WhatsNewState {
  if (!notes.notes.trim()) return state;
  const running = notes.version === state.version;
  if (!running && !isNewerVersion(notes.version, state.version)) return state;
  return {
    ...state,
    notes: [
      ...state.notes.filter(
        (entry) =>
          entry.version !== notes.version &&
          (running || entry.version === state.version),
      ),
      notes,
    ],
  };
}

export function markWhatsNewSeen(
  state: WhatsNewState,
  version: string,
): WhatsNewState {
  if (state.unseen !== version) return state;
  return { notes: state.notes, version: state.version };
}

export async function readWhatsNewState(file: string) {
  try {
    return parseWhatsNewState(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

export async function writeWhatsNewState(file: string, state: WhatsNewState) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function parseWhatsNewState(value: unknown): WhatsNewState | undefined {
  if (!isRecord(value) || typeof value.version !== "string") return undefined;
  const notes = Array.isArray(value.notes)
    ? value.notes.flatMap((entry) => parseReleaseNotes(entry) ?? [])
    : [];
  return {
    notes,
    ...(typeof value.unseen === "string" ? { unseen: value.unseen } : {}),
    version: value.version,
  };
}

function parseReleaseNotes(value: unknown): ReleaseNotes | undefined {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    typeof value.notes !== "string"
  )
    return undefined;
  return {
    notes: value.notes,
    ...(typeof value.releaseDate === "string"
      ? { releaseDate: value.releaseDate }
      : {}),
    version: value.version,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNewerVersion(left: string, right: string) {
  try {
    return compareVersions(`v${left}`, `v${right}`) > 0;
  } catch {
    return false;
  }
}
