import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import { spawn as spawnPty, type IPty } from "node-pty";
import { pathExists, spawnRuntime } from "./workspace-runtime.ts";
import { terminalDirectory, terminalShell } from "./terminal-shell.ts";

type TerminalSession =
  | {
      id: string;
      cwd: string;
      process: ChildProcessWithoutNullStreams;
      runtime: true;
    }
  | {
      id: string;
      cwd: string;
      process: IPty;
      runtime: false;
    };

const sessions = new Map<string, TerminalSession>();
const forceKillDelayMs = 1_500;

export function registerTerminalIpcHandlers() {
  ipcMain.handle("terminal:start", (_event, input: { cwd: string }) =>
    startTerminal(input.cwd),
  );
  ipcMain.handle(
    "terminal:write",
    (_event, input: { id: string; data: string }) =>
      writeTerminal(input.id, input.data),
  );
  ipcMain.handle(
    "terminal:resize",
    (_event, input: { cols: number; id: string; rows: number }) =>
      resizeTerminal(input.id, input.cols, input.rows),
  );
  ipcMain.handle("terminal:stop", (_event, id: string) => stopTerminal(id));
}

async function startTerminal(cwd: string) {
  const directory = terminalDirectory(cwd);
  if (!(await pathExists(directory)))
    throw new Error("Terminal directory does not exist");

  const id = randomUUID();
  const shell = terminalShell(directory);
  if (shell.runtime) {
    const child = spawnRuntime(shell.command, shell.args, {
      cwd: directory,
      env: process.env,
    });
    const session: Extract<TerminalSession, { runtime: true }> = {
      id,
      cwd: directory,
      process: child,
      runtime: true,
    };
    sessions.set(id, session);
    attachChildProcess(session, child);
    return { id, cwd: directory };
  }

  const pty = spawnPty(shell.command, shell.args, {
    cols: 120,
    cwd: directory,
    env: terminalEnvironment(process.env),
    name: "xterm-256color",
    rows: 32,
  });
  const session: Extract<TerminalSession, { runtime: false }> = {
    id,
    cwd: directory,
    process: pty,
    runtime: false,
  };
  sessions.set(id, session);
  pty.onData((data) => emitTerminalEvent(id, "stdout", data));
  pty.onExit(({ exitCode }) => {
    sessions.delete(id);
    emitTerminalEvent(id, "exit", String(exitCode));
  });

  return { id, cwd: directory };
}

function writeTerminal(id: string, data: string) {
  const session = sessions.get(id);
  if (!session) return false;
  if (!session.runtime) {
    session.process.write(data);
    return true;
  }
  if (!isChildProcess(session.process)) return false;
  return writeProcessInput(
    session.process,
    terminalInput(data, session.runtime),
  );
}

function resizeTerminal(id: string, cols: number, rows: number) {
  const session = sessions.get(id);
  if (!session || session.runtime || isChildProcess(session.process))
    return false;
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    rows < 2
  )
    return false;
  session.process.resize(Math.min(cols, 500), Math.min(rows, 200));
  return true;
}

function terminalInput(data: string, runtime: boolean) {
  if (runtime) return data.replace(/\r/g, "\n");
  return process.platform === "win32" ? data.replace(/\r?\n/g, "\r\n") : data;
}

function writeProcessInput(
  child: ChildProcessWithoutNullStreams,
  data: string,
) {
  if (
    child.stdin.destroyed ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      child.stdin.off("error", handleError);
      child.stdin.off("close", handleClose);
      resolve(value);
    };
    const handleError = () => settle(false);
    const handleClose = () => settle(false);
    child.stdin.once("error", handleError);
    child.stdin.once("close", handleClose);
    child.stdin.write(data, (error?: Error | null) => settle(!error));
  });
}

function stopTerminal(id: string) {
  const session = sessions.get(id);
  if (!session) return false;
  stopProcess(session.process);
  sessions.delete(id);
  return true;
}

export async function shutdownTerminalSessions() {
  const activeSessions = Array.from(sessions.values());
  sessions.clear();
  await Promise.all(
    activeSessions.map((session) => stopProcess(session.process)),
  );
}

function attachChildProcess(
  session: Extract<TerminalSession, { runtime: true }>,
  child: ChildProcessWithoutNullStreams,
) {
  child.stdout.on("data", (data: Buffer) =>
    emitTerminalEvent(session.id, "stdout", data.toString()),
  );
  child.stderr.on("data", (data: Buffer) =>
    emitTerminalEvent(session.id, "stderr", data.toString()),
  );
  child.on("exit", (code) => {
    sessions.delete(session.id);
    emitTerminalEvent(session.id, "exit", String(code ?? ""));
  });
}

function stopProcess(process: ChildProcessWithoutNullStreams | IPty) {
  if (isChildProcess(process)) return stopChildProcess(process);
  try {
    process.kill();
  } catch {}
  return Promise.resolve();
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams) {
  killChildProcess(child, "SIGTERM");
  await waitForExit(child);
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killChildProcess(child, "SIGKILL");
      resolve();
    }, forceKillDelayMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killChildProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function isChildProcess(
  process: ChildProcessWithoutNullStreams | IPty,
): process is ChildProcessWithoutNullStreams {
  return "stdin" in process;
}

function terminalEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries({
      ...environment,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

function emitTerminalEvent(
  id: string,
  type: "stdout" | "stderr" | "exit",
  data: string,
) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(`terminal:event:${id}`, { id, type, data });
  });
}
