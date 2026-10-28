import crossSpawn from "cross-spawn";
import { setupPath } from "../host-tool-path.ts";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { withoutTelemetryEnvironment } from "@blame/telemetry";

export type DeviceCommandOptions = {
  cwd?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  output?: (text: string) => void;
  input?: string;
};
export type DeviceCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export interface DeviceHost {
  run(
    command: string,
    args: string[],
    options?: DeviceCommandOptions,
  ): Promise<DeviceCommandResult>;
  spawn(
    command: string,
    args: string[],
    options?: DeviceCommandOptions,
  ): ChildProcessWithoutNullStreams;
}
export const deviceHost: DeviceHost = {
  spawn(command, args, options = {}) {
    return crossSpawn(command, args, {
      cwd: options.cwd,
      env: {
        ...withoutTelemetryEnvironment(process.env),
        PATH: setupPath(),
        ...options.environment,
      },
      signal: options.signal,
      windowsHide: true,
      stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
  },
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = deviceHost.spawn(command, args, options);
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
      let stdout = "",
        stderr = "",
        settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr });
      };
      child.stdout.on("data", (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-4 * 1024 * 1024);
        options.output?.(data.toString());
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4 * 1024 * 1024);
        options.output?.(data.toString());
      });
      child.once("error", (error) => {
        stderr += error.message;
        finish(127);
      });
      child.once("close", (code) => finish(code ?? 1));
      const timer = setTimeout(() => {
        child.kill();
        stderr += "\nThe command timed out.";
        finish(124);
      }, options.timeoutMs ?? 120000);
    });
  },
};
export async function checked(
  host: DeviceHost,
  command: string,
  args: string[],
  options?: DeviceCommandOptions,
) {
  options?.signal?.throwIfAborted();
  const result = await host.run(command, args, options);
  options?.signal?.throwIfAborted();
  if (result.exitCode)
    throw new Error(
      (result.stderr || result.stdout || `${command} could not run.`).slice(
        -8000,
      ),
    );
  return result.stdout.trim();
}
export async function* commandLines(child: ChildProcessWithoutNullStreams) {
  const lines = createInterface({ input: child.stdout });
  child.on("error", () => lines.close());
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    child.kill();
  }
}
export function deviceName(
  story: Pick<import("./types.ts").DeviceStory, "title" | "id">,
) {
  return `Blame · ${story.title.replace(/[\r\n\0]/g, " ").slice(0, 30)} · ${story.id.slice(0, 8)}`;
}

export function captureDeviceBytes(
  host: DeviceHost,
  command: string,
  args: string[],
) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = host.spawn(command, args),
      chunks: Buffer[] = [];
    let size = 0,
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Device capture timed out."));
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        child.kill();
        reject(new Error("Device image is too large."));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(stderr || "The device screenshot failed."));
      else resolve(Buffer.concat(chunks));
    });
  });
}
