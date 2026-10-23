import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";

// Who is listening on a local port: a project's app already running outside
// Blame, another project's, or something Blame cannot tell apart. The
// process's working folder decides; on Windows, where it is not readable,
// its command line stands in.

export type LocalPortOwner =
  | { status: "free" }
  | {
      status: "busy";
      owner: "project" | "other" | "unknown";
      // The folder the process runs in (macOS, Linux), when readable.
      cwd?: string;
      pid?: number;
      processName?: string;
    };

type ListeningProcess = {
  commandLine?: string;
  cwd?: string;
  pid?: number;
  processName?: string;
};

type Dependencies = {
  listening: (port: number) => Promise<boolean>;
  owner: (port: number) => Promise<ListeningProcess | undefined>;
  platform: NodeJS.Platform;
};

const execFileAsync = promisify(execFile);

export async function inspectLocalPort(
  input: { port: number; projectPath: string },
  dependencies: Dependencies = defaultDependencies(),
): Promise<LocalPortOwner> {
  if (!validPort(input.port)) throw new Error("A local port is required.");
  if (!(await dependencies.listening(input.port))) return { status: "free" };
  const listener = await dependencies.owner(input.port).catch(() => undefined);
  return {
    status: "busy",
    owner: classifyPortOwner(
      listener,
      input.projectPath,
      dependencies.platform,
    ),
    ...(listener?.cwd ? { cwd: listener.cwd } : {}),
    ...(listener?.pid ? { pid: listener.pid } : {}),
    ...(listener?.processName ? { processName: listener.processName } : {}),
  };
}

export function classifyPortOwner(
  listener: ListeningProcess | undefined,
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): "project" | "other" | "unknown" {
  if (!listener) return "unknown";
  const cwd = listener.cwd?.trim();
  // A process at the file system root (Docker's port proxy, a system
  // service) says nothing about which project it serves.
  if (cwd && !rootFolder(cwd, platform)) {
    return insideFolder(cwd, projectPath, platform) ? "project" : "other";
  }
  if (
    listener.commandLine &&
    mentionsFolder(listener.commandLine, projectPath, platform)
  )
    return "project";
  return "unknown";
}

function insideFolder(path: string, folder: string, platform: NodeJS.Platform) {
  const paths =
    platform === "win32" ? win32 : { relative, resolve, isAbsolute };
  const caseless = platform === "win32" || platform === "darwin";
  const normalize = (value: string) => {
    const resolved = paths.resolve(value);
    return caseless ? resolved.toLowerCase() : resolved;
  };
  const between = paths.relative(normalize(folder), normalize(path));
  return (
    between === "" || (!between.startsWith("..") && !paths.isAbsolute(between))
  );
}

function mentionsFolder(
  commandLine: string,
  folder: string,
  platform: NodeJS.Platform,
) {
  const normalize = (value: string) => {
    const slashes = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin"
      ? slashes.toLowerCase()
      : slashes;
  };
  const line = normalize(commandLine);
  const target = normalize(folder);
  const index = line.indexOf(target);
  if (index < 0) return false;
  // The folder itself, not one whose name merely starts the same way.
  const next = line[index + target.length];
  return next === undefined || /[/"'\s]/.test(next);
}

function rootFolder(path: string, platform: NodeJS.Platform) {
  return platform === "win32"
    ? /^[a-z]:[\\/]?$/i.test(path)
    : path.replace(/\/+$/, "") === "";
}

// The local port a preview address serves on, when it is on this computer.
export function previewPort(previewUrl: string | undefined) {
  if (!previewUrl) return undefined;
  try {
    const url = new URL(
      /^https?:\/\//.test(previewUrl) ? previewUrl : `http://${previewUrl}`,
    );
    if (!localHost(url.hostname)) return undefined;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function localHost(hostname: string) {
  return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(
    hostname.toLowerCase(),
  );
}

function validPort(port: number) {
  return Number.isInteger(port) && port > 0 && port < 65_536;
}

function defaultDependencies(): Dependencies {
  return {
    listening: portListening,
    owner: (port) =>
      process.platform === "win32"
        ? windowsListeningProcess(port)
        : unixListeningProcess(port, process.platform),
    platform: process.platform,
  };
}

// Dev servers listen on IPv4, IPv6 or both: either answering means busy.
async function portListening(port: number) {
  const answers = await Promise.all(
    ["127.0.0.1", "::1"].map((host) => connects(host, port)),
  );
  return answers.some(Boolean);
}

function connects(host: string, port: number) {
  return new Promise<boolean>((done) => {
    const socket = connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function unixListeningProcess(
  port: number,
  platform: NodeJS.Platform,
): Promise<ListeningProcess | undefined> {
  const { stdout } = await execFileAsync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
    { timeout: 3_000 },
  );
  const listening = parseLsofProcess(stdout);
  if (!listening?.pid) return listening;
  const cwd = await processFolder(listening.pid, platform).catch(
    () => undefined,
  );
  return { ...listening, ...(cwd ? { cwd } : {}) };
}

export function parseLsofProcess(output: string) {
  let pid: number | undefined;
  let processName: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p") && pid === undefined) pid = Number(line.slice(1));
    else if (line.startsWith("c") && processName === undefined)
      processName = line.slice(1);
  }
  if (!pid || !Number.isFinite(pid)) return undefined;
  return { pid, ...(processName ? { processName } : {}) };
}

async function processFolder(pid: number, platform: NodeJS.Platform) {
  if (platform === "linux") return readlink(`/proc/${pid}/cwd`);
  const { stdout } = await execFileAsync(
    "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    { timeout: 3_000 },
  );
  return stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}

async function windowsListeningProcess(
  port: number,
): Promise<ListeningProcess | undefined> {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($c) {",
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"',
    "  @{ pid = $c.OwningProcess; name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5_000, windowsHide: true },
  );
  return parseWindowsProcess(stdout);
}

export function parseWindowsProcess(
  output: string,
): ListeningProcess | undefined {
  const text = output.trim();
  if (!text) return undefined;
  const value = JSON.parse(text) as {
    commandLine?: unknown;
    name?: unknown;
    pid?: unknown;
  };
  const pid = Number(value.pid);
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  return {
    pid,
    ...(typeof value.name === "string" ? { processName: value.name } : {}),
    ...(typeof value.commandLine === "string"
      ? { commandLine: value.commandLine }
      : {}),
  };
}
