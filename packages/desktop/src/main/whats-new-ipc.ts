import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { privacyPreferences } from "./privacy-settings";
import {
  currentReleaseNotes,
  launchWhatsNew,
  markWhatsNewSeen,
  readWhatsNewState,
  whatsNewToShow,
  withReleaseNotes,
  writeWhatsNewState,
  type ReleaseNotes,
  type WhatsNewState,
} from "./whats-new";

let state: Promise<WhatsNewState> | undefined;

// The launch is recorded right away, before any update check reports notes.
export function registerWhatsNewIpcHandlers() {
  void loadState();
  ipcMain.handle("whats-new:get", async () => (await notesToShow()) ?? null);
  ipcMain.handle(
    "whats-new:current",
    async () => currentReleaseNotes(await loadState()) ?? null,
  );
  ipcMain.handle("whats-new:dismiss", async (_event, version: unknown) => {
    if (typeof version !== "string") throw new Error("Invalid version");
    await update((current) => markWhatsNewSeen(current, version));
  });
}

/** Keeps the notes an update check or a download brought. */
export async function rememberReleaseNotes(notes: ReleaseNotes) {
  await update((current) => withReleaseNotes(current, notes));
  const shown = await notesToShow();
  if (shown?.version !== notes.version) return;
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("whats-new:available", shown);
  });
}

async function notesToShow() {
  return whatsNewToShow(await loadState(), privacyPreferences().updateChecks);
}

function loadState() {
  state ??= readWhatsNewState(stateFile()).then(async (saved) => {
    const launched = launchWhatsNew(saved, app.getVersion());
    await save(launched);
    return launched;
  });
  return state;
}

// Changes apply one after another, so a dismissal never loses arrived notes.
function update(change: (current: WhatsNewState) => WhatsNewState) {
  state = loadState().then(async (current) => {
    const next = change(current);
    if (next !== current) await save(next);
    return next;
  });
  return state;
}

// Losing this file only skips one screen; it never blocks the app.
async function save(next: WhatsNewState) {
  try {
    await writeWhatsNewState(stateFile(), next);
  } catch (error) {
    console.warn("Could not save the What's new state", error);
  }
}

function stateFile() {
  return join(app.getPath("userData"), "whats-new.json");
}
