import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import type { DeviceHost } from "./device-host.ts";
import type { DeviceBuildResult, DeviceStory } from "./types.ts";
import { failedDeviceBuild } from "./build-errors.ts";

/** Resident Flutter daemon. Rebuild is a hot restart of the same app. */
export class FlutterDeviceSession extends EventEmitter {
  private host: DeviceHost;
  private process?: ChildProcessWithoutNullStreams;
  private appId?: string;
  private output: string[] = [];
  private nextId = 1;
  private requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(host: DeviceHost) { super(); this.host = host; }
  async build(story: DeviceStory, target: PreviewManifestDeviceTarget, cwd: string, deviceId: string, progress: (step: string) => void, signal: AbortSignal): Promise<DeviceBuildResult> {
    const started = Date.now();
    try {
      if (this.process && this.appId) {
        progress("Restarting the Flutter app");
        await this.request("app.restart", { appId: this.appId, fullRestart: true, pause: false }, signal);
        return { ok: true, artifact: `flutter:${this.appId}`, durationMs: Date.now() - started };
      }
      progress("Building the Flutter app");
      const child = this.host.spawn("flutter", ["run", "-d", deviceId, "--machine", ...(target.build.flavor ? ["--flavor", target.build.flavor] : []), ...(target.build.target ? ["--target", target.build.target] : [])], { cwd, environment: story.environment });
      this.process = child;
      const lines = createInterface({ input: child.stdout });
      const append = (text: string) => { this.output = [...this.output, text].slice(-200); this.emit("log", text); };
      child.stderr.on("data", (data: Buffer) => append(data.toString()));
      child.on("error", (error) => this.emit("failed", error));
      child.once("close", (code) => { lines.close(); this.process = undefined; this.appId = undefined; this.emit("failed", new Error(`Flutter stopped with code ${code ?? 1}.`)); });
      lines.on("line", (line: string) => {
        let messages: Array<Record<string, unknown>>;
        try { const value: unknown = JSON.parse(line); messages = Array.isArray(value) ? value : [value as Record<string, unknown>]; } catch { append(line); return; }
        for (const message of messages) {
          if (typeof message.id === "number") { const request = this.requests.get(message.id); this.requests.delete(message.id); if (message.error) request?.reject(new Error(JSON.stringify(message.error))); else request?.resolve(message.result); }
          const params = message.params as Record<string, unknown> | undefined;
          if (message.event === "app.start") this.appId = String(params?.appId ?? "");
          if (message.event === "app.started") { this.appId = String(params?.appId ?? this.appId ?? ""); this.emit("ready"); }
          if (message.event === "app.log") append(String(params?.log ?? ""));
          if (message.event === "app.progress") progress(String(params?.message ?? "Building the app"));
        }
      });
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.off("ready", ready); this.off("failed", failed); if (error) reject(error); else resolve(); };
        const ready = () => finish(), failed = (error: Error) => finish(error), abort = () => { this.close(); finish(new Error("Build cancelled")); };
        const timer = setTimeout(() => { this.close(); finish(new Error("Flutter did not finish building within 20 minutes.")); }, 20 * 60000);
        this.once("ready", ready); this.once("failed", failed); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
      return { ok: true, artifact: `flutter:${this.appId}`, durationMs: Date.now() - started };
    } catch (error) { return failedDeviceBuild(this.output.join("\n") + "\n" + String(error), story.buildRoot, story.worktree); }
  }
  private async request(method: string, params: unknown, signal: AbortSignal) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.requests.delete(id); if (error) reject(error); else resolve(value); };
      const abort = () => finish(new Error("Flutter restart cancelled"));
      const timer = setTimeout(() => finish(new Error("Flutter restart timed out")), 120000);
      this.requests.set(id, { resolve: (value) => finish(undefined, value), reject: finish });
      signal.addEventListener("abort", abort, { once: true });
      this.process?.stdin.write(JSON.stringify([{ id, method, params }]) + "\n");
      if (signal.aborted) abort();
    });
  }
  async *logs(signal: AbortSignal) {
    const queue: string[] = [...this.output];
    const add = (line: string) => { queue.push(line); if (queue.length > 200) queue.shift(); };
    this.on("log", add);
    try { while (!signal.aborted && this.process) { if (queue.length) yield queue.shift()!; else await new Promise((resolve) => setTimeout(resolve, 100)); } } finally { this.off("log", add); }
  }
  close() { this.process?.kill(); this.process = undefined; this.appId = undefined; for (const request of this.requests.values()) request.reject(new Error("Flutter stopped")); this.requests.clear(); }
}
