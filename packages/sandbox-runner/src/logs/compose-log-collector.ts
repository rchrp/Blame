import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./log-multiplexer.js";
import { runtimePaths } from "../runtime-paths.js";

const collectorPidRoot = "/run/blame/log-collectors";
const dockerEnvironment = { DOCKER_HOST: "unix:///run/blame/docker.sock" };

export async function startComposeLogCollectors(serviceIds: string[]) {
  await stopComposeLogCollectors();
  await mkdir(collectorPidRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimePaths.logs, { recursive: true, mode: 0o700 });
  const executable = process.argv[1];
  if (!executable) throw new Error("Runner executable path is unavailable.");
  for (const serviceId of serviceIds) {
    const id = safeId(serviceId);
    await writeFile(join(runtimePaths.logs, `${id}.log`), "", {
      mode: 0o600,
    });
    const diagnostic = await open(
      join(runtimePaths.logs, `${id}.collector.log`),
      "a",
      0o600,
    );
    const child = spawn(
      process.execPath,
      [executable, "collect-compose-logs", "--service", serviceId],
      { detached: true, stdio: ["ignore", diagnostic.fd, diagnostic.fd] },
    );
    child.unref();
    if (!child.pid) throw new Error("Unable to start Compose log collector.");
    await writeFile(join(collectorPidRoot, `${id}.pid`), String(child.pid), {
      mode: 0o600,
      flush: true,
    });
  }
}

export async function stopComposeLogCollectors() {
  const entries = await readdir(collectorPidRoot).catch(() => []);
  const pids = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".pid"))
      .map((entry) =>
        readFile(join(collectorPidRoot, entry), "utf8")
          .then(Number)
          .catch(() => 0),
      ),
  );
  for (const pid of pids) signalGroup(pid, "SIGTERM");
  if (pids.some(Boolean)) await delay(500);
  for (const pid of pids) signalGroup(pid, "SIGKILL");
  await rm(collectorPidRoot, { recursive: true, force: true });
}

export async function collectComposeLogs(serviceId: string) {
  if (safeId(serviceId) !== serviceId)
    throw new Error("Invalid log service ID.");
  const path = join(runtimePaths.logs, `${serviceId}.log`);
  const child = spawn(
    "docker",
    [
      "compose",
      "-f",
      runtimePaths.composeFile,
      "logs",
      "--follow",
      "--no-color",
      "--no-log-prefix",
      "--tail",
      "1000",
      serviceId,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...dockerEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let writeQueue: Promise<void> = Promise.resolve();
  const appendRedacted = (lines: string[]) => {
    const content = lines
      .filter(Boolean)
      .map((line) => redact(line))
      .join("\n");
    if (!content) return;
    writeQueue = writeQueue.then(() =>
      appendFile(path, `${content}\n`, { mode: 0o600 }),
    );
  };
  const consume = (stream: NodeJS.ReadableStream) => {
    let pending = "";
    stream.on("data", (chunk: Buffer) => {
      const lines = `${pending}${chunk.toString("utf8")}`.split("\n");
      pending = lines.pop() ?? "";
      appendRedacted(lines);
    });
    stream.on("end", () => appendRedacted([pending]));
  };
  consume(child.stdout);
  consume(child.stderr);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  await writeQueue;
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The engine's own output: setup tasks and Compose start, shown as "setup". */
export const setupLogId = "setup";
let setupLogWrites = Promise.resolve();
export function appendSetupLog(text: string) {
  setupLogWrites = setupLogWrites
    .then(async () => {
      await mkdir(runtimePaths.logs, { recursive: true, mode: 0o700 });
      await appendFile(join(runtimePaths.logs, `${setupLogId}.log`), text, {
        mode: 0o600,
      });
    })
    .catch(() => undefined);
}
