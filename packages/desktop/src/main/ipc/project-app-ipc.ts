import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { ipcMain, type WebContents } from "electron";
import { appWindowWithProject } from "../app-windows";
import { inspectLocalPort, previewPort } from "../local-port-owner";

// The open project's app, as the app's shared runner sees it: who holds its
// port, and (for an agent working in the project folder) its state or a
// start through that same runner, answered by the project's window.

export type ProjectAppAction = "start" | "status";

export type ProjectAppResult = {
  status:
    | "conflict"
    | "failed"
    | "running"
    | "starting"
    | "stopped"
    | "unavailable";
  message: string;
  configuration?: string;
  logs?: string;
  owner?: { kind: "other" | "unknown"; folder?: string; process?: string };
  previewUrl?: string;
  runningOutsideBlame?: boolean;
};

type Pending = {
  resolve(result: ProjectAppResult): void;
  timer: NodeJS.Timeout;
  webContentsId: number;
};

const pending = new Map<string, Pending>();
const answerTimeoutMs = 15_000;
const startTimeoutMs = 90_000;

export function registerProjectAppIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("project-app:inspect-port", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Port inspection was rejected");
    const body = record(value);
    return inspectLocalPort({
      port: Number(body.port),
      projectPath: requiredString(body.projectPath, "projectPath"),
    });
  });
  ipcMain.handle("project-app:respond", (event, value) => {
    const body = record(value);
    const id = typeof body.id === "string" ? body.id : "";
    const entry = pending.get(id);
    if (!entry || entry.webContentsId !== event.sender.id) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(projectAppResult(body.result));
    return true;
  });
}

// For the agent: a start returns once the app answers on its port (or
// fails), so the agent can inspect it right after.
export async function projectAppForAgent(
  input: { action: ProjectAppAction; projectPath: string },
  signal?: AbortSignal,
): Promise<ProjectAppResult> {
  const result = await askProjectWindow(input);
  if (input.action !== "start" || result.status !== "starting") return result;
  const port = previewPort(result.previewUrl);
  if (!port) return result;
  const answered = await waitForPort(port, startTimeoutMs, signal);
  if (answered)
    return {
      ...result,
      status: "running",
      message: `${result.configuration ?? "The app"} is running at ${result.previewUrl}.`,
    };
  const latest = await askProjectWindow({ ...input, action: "status" });
  return {
    ...latest,
    status: "failed",
    message: `${result.configuration ?? "The app"} did not answer on port ${port} within ${startTimeoutMs / 1_000} seconds. Read its logs.`,
  };
}

function askProjectWindow(input: {
  action: ProjectAppAction;
  projectPath: string;
}): Promise<ProjectAppResult> {
  const window = appWindowWithProject(input.projectPath);
  if (!window)
    return Promise.resolve({
      status: "unavailable",
      message:
        "The project is not open in a Blame window, so its app cannot be checked or started.",
    });
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        status: "unavailable",
        message: "Blame's window did not answer about the project's app.",
      });
    }, answerTimeoutMs);
    pending.set(id, { resolve, timer, webContentsId: window.webContents.id });
    window.webContents.send("project-app:request", {
      action: input.action,
      id,
    });
  });
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (await portAnswers(port)) return true;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return false;
}

function portAnswers(port: number) {
  return Promise.all(
    ["127.0.0.1", "::1"].map(
      (host) =>
        new Promise<boolean>((done) => {
          const socket = connect({ host, port });
          const finish = (value: boolean) => {
            socket.destroy();
            done(value);
          };
          socket.setTimeout(400, () => finish(false));
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
        }),
    ),
  ).then((answers) => answers.some(Boolean));
}

const statuses = new Set<ProjectAppResult["status"]>([
  "conflict",
  "failed",
  "running",
  "starting",
  "stopped",
  "unavailable",
]);

function projectAppResult(value: unknown): ProjectAppResult {
  const body = record(value);
  const status = statuses.has(body.status as ProjectAppResult["status"])
    ? (body.status as ProjectAppResult["status"])
    : "unavailable";
  const owner = record(body.owner);
  return {
    status,
    message:
      typeof body.message === "string" ? body.message.slice(0, 2_000) : "",
    ...(typeof body.configuration === "string"
      ? { configuration: body.configuration }
      : {}),
    ...(typeof body.logs === "string" ? { logs: body.logs.slice(-6_000) } : {}),
    ...(owner.kind === "other" || owner.kind === "unknown"
      ? {
          owner: {
            kind: owner.kind,
            ...(typeof owner.folder === "string"
              ? { folder: owner.folder }
              : {}),
            ...(typeof owner.process === "string"
              ? { process: owner.process }
              : {}),
          },
        }
      : {}),
    ...(typeof body.previewUrl === "string"
      ? { previewUrl: body.previewUrl }
      : {}),
    ...(body.runningOutsideBlame === true ? { runningOutsideBlame: true } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}
