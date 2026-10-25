import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { app, shell } from "electron";
import { attachmentOpenInput } from "./attachment-open-input";

const directories = new Set<string>();
let cleanupRegistered = false;

export async function openAttachment(value: unknown) {
  const input = attachmentOpenInput(value);
  const directory = await mkdtemp(join(app.getPath("temp"), "blame-attachment-"));
  directories.add(directory);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    app.once("will-quit", () => {
      for (const path of directories) {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* The default app may still hold the file on Windows. */ }
      }
    });
  }
  try {
    const path = join(directory, input.name);
    await writeFile(path, input.content, { mode: 0o600, flag: "wx" });
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  } catch (error) {
    directories.delete(directory);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
