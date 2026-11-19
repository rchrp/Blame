import { rmSync } from "node:fs";
import { join } from "node:path";
import { app, clipboard, ipcMain, type WebContents } from "electron";
import { RunLogStore } from "./run-log-store.ts";

// The run logs of each window, kept on disk while it shows them: gone with
// the window, once it loads again, and when the app quits.
export function registerRunLogIpcHandlers() {
  const directory = join(app.getPath("userData"), "run-logs");
  const store = new RunLogStore(directory);
  const windows = new Set<WebContents>();
  const keyOf = (sender: WebContents, id: unknown) =>
    typeof id === "string" && id.length <= 64 ? `${sender.id}:${id}` : "";
  const watch = (sender: WebContents) => {
    if (windows.has(sender)) return;
    windows.add(sender);
    const release = () => store.closeAll(`${sender.id}:`);
    sender.on("did-navigate", release);
    sender.once("destroyed", () => {
      windows.delete(sender);
      release();
    });
  };

  ipcMain.on("run-log:append", (event, id: unknown, lines: unknown) => {
    const key = keyOf(event.sender, id);
    if (!key || typeof lines !== "string") return;
    watch(event.sender);
    store.append(key, lines);
  });
  ipcMain.handle("run-log:read", (event, id: unknown, from, to) => {
    const key = keyOf(event.sender, id);
    if (!key || !Number.isSafeInteger(from) || !Number.isSafeInteger(to))
      return [];
    return store.read(key, from, Math.min(to, from + 10_000));
  });
  ipcMain.handle(
    "run-log:copy",
    async (
      event,
      id: unknown,
      before: unknown,
      after: unknown,
      endsSelection: unknown,
    ) => {
      const key = keyOf(event.sender, id);
      if (!key || typeof before !== "string" || typeof after !== "string")
        return;
      const text = await store.text(key);
      await clipboard.writeText(
        `${before}${endsSelection === true ? text.replace(/\n$/, "") : text}${after}`,
      );
    },
  );
  ipcMain.on("run-log:close", (event, id: unknown) => {
    const key = keyOf(event.sender, id);
    if (key) store.close(key);
  });
  app.once("will-quit", () => {
    rmSync(directory, { force: true, recursive: true });
  });
}
