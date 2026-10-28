import { setupPath } from "../host-tool-path.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { withoutTelemetryEnvironment } from "@blame/telemetry";

export type DeviceCommandOptions = { cwd?: string; environment?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; output?: (text: string) => void };
export type DeviceCommandResult = { exitCode: number; stdout: string; stderr: string };
export interface DeviceHost {
  run(command: string, args: string[], options?: DeviceCommandOptions): Promise<DeviceCommandResult>;
  spawn(command: string, args: string[], options?: DeviceCommandOptions): ChildProcessWithoutNullStreams;
}
export const deviceHost: DeviceHost = {
  spawn(command, args, options = {}) {
    return spawn(command, args, { cwd: options.cwd, env: { ...withoutTelemetryEnvironment(process.env), PATH: setupPath(), ...options.environment }, signal: options.signal, windowsHide: true, stdio: "pipe" });
  },
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = deviceHost.spawn(command, args, options);
      let stdout = "", stderr = "", settled = false;
      const finish = (exitCode: number) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ exitCode, stdout, stderr }); };
      child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(-4 * 1024 * 1024); options.output?.(data.toString()); });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4 * 1024 * 1024); options.output?.(data.toString()); });
      child.once("error", (error) => { stderr += error.message; finish(127); });
      child.once("close", (code) => finish(code ?? 1));
      const timer = setTimeout(() => { child.kill(); stderr += "\nThe command timed out."; finish(124); }, options.timeoutMs ?? 120000);
    });
  },
};
export async function checked(host: DeviceHost, command: string, args: string[], options?: DeviceCommandOptions) {
  const result = await host.run(command, args, options);
  if (result.exitCode) throw new Error((result.stderr || result.stdout || `${command} could not run.`).slice(-8000));
  return result.stdout.trim();
}
export async function* commandLines(child: ChildProcessWithoutNullStreams) {
  const lines = createInterface({ input: child.stdout });
  child.on("error", () => lines.close());
  try { for await (const line of lines) yield line; } finally { lines.close(); child.kill(); }
}
export function deviceName(story: Pick<import("./types.ts").DeviceStory, "title" | "id">) { return `Blame · ${story.title.replace(/[\r\n\0]/g, " ").slice(0, 30)} · ${story.id.slice(0, 8)}`; }
