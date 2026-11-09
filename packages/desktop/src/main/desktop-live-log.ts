import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { redactLogData } from "./desktop-log-redaction";
import { grantedGithubTokens } from "./github-access/agent-github-access.ts";

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";

const consoleMethods: ConsoleMethod[] = [
  "debug",
  "error",
  "info",
  "log",
  "warn",
];
const originalConsole = new Map<ConsoleMethod, (...data: unknown[]) => void>();
const maximumLogBytes = 10 * 1024 * 1024;
const maximumPendingWrites = 1_000;
const retainedLogFiles = 3;
let currentLogBytes: number | undefined;
let pendingWrites = 0;
let writeQueue = Promise.resolve();

export function registerLiveLogCapture() {
  for (const method of consoleMethods) {
    originalConsole.set(method, console[method]);
    console[method] = (...data: unknown[]) => {
      appendLiveLog(method, data);
      originalConsole.get(method)?.(...data);
    };
  }

  process.on("uncaughtException", (error) => {
    appendLiveLog("uncaughtException", [error]);
  });

  process.on("unhandledRejection", (reason) => {
    appendLiveLog("unhandledRejection", [reason]);
  });

  process.on("warning", (warning) => {
    appendLiveLog("warning", [warning]);
  });
}

export function attachLiveLogWindow(window: BrowserWindow) {
  window.webContents.on(
    "console-message",
    (_event, level, message, line, source) => {
      appendLiveLog("renderer", [`level=${level}`, source, line, message]);
    },
  );

  window.webContents.on("render-process-gone", (_event, details) => {
    appendLiveLog("renderer-process-gone", [details]);
  });
}

function appendLiveLog(scope: string, data: unknown[]) {
  try {
    const values = redactLogData(data, grantedGithubTokens());
    writeLogLine(
      `[${new Date().toISOString()}] [${scope}] ${values.map(formatLogValue).join(" ")}\n`,
    );
  } catch {}
}

function formatLogValue(value: unknown) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function liveLogPath() {
  return join(app.getPath("userData"), "logs", "blame-live.log");
}

function writeLogLine(line: string) {
  if (pendingWrites >= maximumPendingWrites) return;
  pendingWrites += 1;
  writeQueue = writeQueue
    .then(() => appendRotatingLog(line))
    .catch(() => undefined)
    .finally(() => {
      pendingWrites -= 1;
    });
}

export function flushLiveLogs() {
  return writeQueue;
}

async function appendRotatingLog(line: string) {
  const path = liveLogPath();
  await mkdir(dirname(path), { recursive: true });
  const lineBytes = Buffer.byteLength(line);
  const fileBytes = await currentLiveLogBytes(path);
  if (fileBytes + lineBytes > maximumLogBytes) await rotateLiveLogs(path);
  await appendFile(path, line, "utf8");
  currentLogBytes = (currentLogBytes ?? 0) + lineBytes;
}

async function currentLiveLogBytes(path: string) {
  if (currentLogBytes !== undefined) return currentLogBytes;
  try {
    currentLogBytes = (await stat(path)).size;
  } catch {
    currentLogBytes = 0;
  }
  return currentLogBytes;
}

async function rotateLiveLogs(path: string) {
  await rm(`${path}.${retainedLogFiles}`, { force: true });
  for (let index = retainedLogFiles - 1; index >= 1; index -= 1) {
    await moveLogFile(`${path}.${index}`, `${path}.${index + 1}`);
  }
  await moveLogFile(path, `${path}.1`);
  currentLogBytes = 0;
}

async function moveLogFile(source: string, destination: string) {
  try {
    await rm(destination, { force: true });
    await rename(source, destination);
  } catch {}
}
