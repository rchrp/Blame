import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, net } from "electron";
import electronUpdater from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import YAML from "yaml";
import {
  betaFeedUrl,
  isUpdateChannel,
  readUpdateChannel,
  updateMetadataFile,
  writeUpdateChannel,
  type DesktopUpdateChannel,
} from "./desktop-update-channel";

const { autoUpdater } = electronUpdater;

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export type DesktopUpdateStatus = {
  channel: DesktopUpdateChannel;
  currentVersion: string;
  error?: string;
  latestVersion?: string;
  phase: DesktopUpdatePhase;
  progress?: number;
  reason?: string;
  releaseDate?: string;
  releaseNotes?: string;
};

type DesktopUpdateOptions = {
  beforeInstall(): Promise<void>;
};

let channel: DesktopUpdateChannel = "stable";
let status: DesktopUpdateStatus = initialStatus();
let configured = false;
let channelLoaded: Promise<void> | undefined;
// Set once the beta channel replaced the feed built into the app.
let customFeed = false;

export function registerDesktopUpdateIpcHandlers(
  options: DesktopUpdateOptions,
) {
  configureUpdater();

  ipcMain.handle("updates:get-status", () => status);
  ipcMain.handle("updates:check", async () => {
    await checkForUpdates();
    return status;
  });
  ipcMain.handle("updates:download", async () => {
    await downloadUpdate();
    return status;
  });
  ipcMain.handle("updates:install", async () => {
    await installUpdate(options);
    return status;
  });
  ipcMain.handle("updates:set-channel", async (_event, next: unknown) => {
    await setChannel(next);
    return status;
  });
}

export function checkForUpdatesOnStartup() {
  if (!isUpdaterSupported()) return;
  setTimeout(() => {
    void checkForUpdates();
  }, 2_000);
}

function configureUpdater() {
  if (configured) return;
  configured = true;
  channelLoaded = readUpdateChannel(channelFile()).then((saved) => {
    channel = saved;
    setStatus({ ...status, channel });
  });
  if (!isUpdaterSupported()) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setStatus({ ...baseStatus(), phase: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setStatus(updateStatus("available", info));
  });

  autoUpdater.on("update-not-available", (info) => {
    setStatus(updateStatus("not-available", info));
  });

  autoUpdater.on("download-progress", (progress) => {
    setStatus(downloadStatus(progress));
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus(updateStatus("downloaded", info));
  });

  autoUpdater.on("error", (error) => {
    setStatus({ ...baseStatus(), error: errorMessage(error), phase: "error" });
  });
}

async function checkForUpdates() {
  if (!isUpdaterSupported()) {
    setStatus(unsupportedStatus());
    return;
  }
  if (status.phase === "checking" || status.phase === "downloading") return;

  setStatus({ ...baseStatus(), phase: "checking" });
  try {
    await channelLoaded;
    await useChannelFeed();
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus({ ...baseStatus(), error: errorMessage(error), phase: "error" });
  }
}

async function downloadUpdate() {
  if (!isUpdaterSupported()) {
    setStatus(unsupportedStatus());
    return;
  }
  if (status.phase === "downloading" || status.phase === "downloaded") return;
  if (status.phase !== "available") return;

  setStatus({ ...status, phase: "downloading", progress: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setStatus({ ...baseStatus(), error: errorMessage(error), phase: "error" });
  }
}

async function setChannel(next: unknown) {
  if (!isUpdateChannel(next))
    throw new Error(`Unknown update channel: ${next}`);
  await channelLoaded;
  if (next === channel) return;
  channel = next;
  await writeUpdateChannel(channelFile(), channel);
  // A download in progress or ready to install keeps going; the next check
  // uses the new channel.
  if (status.phase === "downloading" || status.phase === "downloaded") {
    setStatus({ ...status, channel });
    return;
  }
  setStatus({ ...initialStatus() });
  await checkForUpdates();
}

async function useChannelFeed() {
  if (channel === "beta") {
    const metadata = updateMetadataFile(process.platform, process.arch);
    const url = await betaFeedUrl(
      (input, init) => net.fetch(input, init),
      metadata,
    );
    if (url) {
      autoUpdater.setFeedURL({ provider: "generic", url });
      customFeed = true;
      return;
    }
  }
  if (!customFeed) return;
  autoUpdater.setFeedURL(await builtInFeed());
  customFeed = false;
}

// electron-builder writes the stable feed into app-update.yml.
async function builtInFeed() {
  const file = join(process.resourcesPath, "app-update.yml");
  const { provider, url } = YAML.parse(await readFile(file, "utf8"));
  return { provider, url };
}

function channelFile() {
  return join(app.getPath("userData"), "update-channel.json");
}

async function installUpdate(options: DesktopUpdateOptions) {
  if (status.phase !== "downloaded") return;
  await options.beforeInstall();
  autoUpdater.quitAndInstall(false, true);
}

function initialStatus(): DesktopUpdateStatus {
  if (!isUpdaterSupported()) return unsupportedStatus();
  return baseStatus();
}

function unsupportedStatus(): DesktopUpdateStatus {
  return {
    ...baseStatus(),
    phase: "unsupported",
    reason: app.isPackaged
      ? "Updates are unavailable for this package."
      : "Updates are unavailable in development.",
  };
}

function baseStatus(): DesktopUpdateStatus {
  return {
    channel,
    currentVersion: app.getVersion(),
    phase: "idle",
  };
}

function updateStatus(
  phase: DesktopUpdatePhase,
  info: UpdateInfo,
): DesktopUpdateStatus {
  return {
    ...baseStatus(),
    latestVersion: info.version,
    phase,
    releaseDate: info.releaseDate,
    releaseNotes: releaseNotes(info.releaseNotes),
  };
}

function downloadStatus(progress: ProgressInfo): DesktopUpdateStatus {
  return {
    ...status,
    phase: "downloading",
    progress: progress.percent,
  };
}

function releaseNotes(value: UpdateInfo["releaseNotes"]) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((note) => note.note)
    .filter(Boolean)
    .join("\n\n");
}

function isUpdaterSupported() {
  return app.isPackaged;
}

function setStatus(nextStatus: DesktopUpdateStatus) {
  status = nextStatus;
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("updates:status", status);
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
