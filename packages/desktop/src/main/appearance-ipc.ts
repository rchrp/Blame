import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, ipcMain, nativeTheme, type WebContents } from "electron";
import type { AppTheme } from "@blame/app";

export function registerAppearanceIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  // Cache the renderer's preference so the first window already has the
  // right native appearance, before React or localStorage is available.
  const file = join(app.getPath("userData"), "appearance.json");
  nativeTheme.themeSource = readTheme(file);
  let pendingWrite = Promise.resolve();

  ipcMain.handle("appearance:set-theme", (event, theme: unknown) => {
    // Auxiliary windows inherit the native theme; only app windows own it.
    if (!input.isAppWindow(event.sender)) return;
    if (!isTheme(theme)) throw new Error("Invalid appearance theme");
    if (nativeTheme.themeSource === theme) return pendingWrite;

    nativeTheme.themeSource = theme;
    const write = pendingWrite.then(() => writeTheme(file, theme));
    // Serialize rapid changes, and let later saves recover from an I/O error.
    pendingWrite = write.catch(() => undefined);
    return write;
  });
}

function readTheme(file: string): AppTheme {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (isTheme(value?.theme)) return value.theme;
  } catch {
    // Missing or invalid preferences fall back to the OS appearance.
  }
  return "system";
}

async function writeTheme(file: string, theme: AppTheme) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ theme })}\n`, "utf8");
  await rename(temporary, file);
}

function isTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark" || value === "system";
}
