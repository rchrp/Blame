import { homedir } from "node:os";
import {
  app,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type RenderProcessGoneDetails,
  type WebContents,
} from "electron";
import {
  githubIssueUrl,
  parseIssueReport,
  type IssueReport,
} from "./github-issue";

// A crash offers a GitHub issue once per launch, so repeated errors never
// stack dialogs.
let crashOffered = false;

export function registerGithubIssueIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("github-issue:open", (event, value: unknown) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Issue report request was rejected");
    return openGithubIssue(parseIssueReport(value));
  });
}

export function offerGithubIssueOnMainError(
  window: () => BrowserWindow | undefined,
) {
  process.on("uncaughtException", (error) => {
    void offerGithubIssue(window(), {
      error: error.stack || String(error),
      title: `Main process error: ${firstLine(error.message || String(error))}`,
    });
  });
}

export function offerGithubIssueOnRendererGone(window: BrowserWindow) {
  window.webContents.on(
    "render-process-gone",
    (_event, details: RenderProcessGoneDetails) => {
      if (details.reason === "clean-exit" || details.reason === "killed")
        return;
      void offerGithubIssue(window, {
        error: `The window stopped (${details.reason}, exit code ${details.exitCode}).`,
        title: `Window stopped: ${details.reason}`,
      });
    },
  );
}

async function offerGithubIssue(
  window: BrowserWindow | undefined,
  report: IssueReport,
) {
  if (crashOffered) return;
  crashOffered = true;
  await app.whenReady();
  const options = {
    buttons: ["Report on GitHub", "Close"],
    cancelId: 1,
    defaultId: 0,
    detail: `${firstLine(report.error)}\n\nReporting opens a pre-filled GitHub issue in your browser. Nothing is sent until you submit it there.`,
    message: "Blame ran into a problem",
    noLink: true,
    type: "error" as const,
  };
  const parent = window && !window.isDestroyed() ? window : undefined;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response === 0) await openGithubIssue(report);
}

function openGithubIssue(report: IssueReport) {
  return shell.openExternal(
    githubIssueUrl(report, {
      arch: process.arch,
      home: homedir(),
      os: `${systemName(process.platform)} ${process.getSystemVersion()}`,
      version: app.getVersion(),
    }),
  );
}

function systemName(platform: NodeJS.Platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function firstLine(text: string) {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "";
}
