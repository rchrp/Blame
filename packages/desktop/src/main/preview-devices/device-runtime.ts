import { randomUUID } from "node:crypto";
import { app, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceHost, checked } from "./device-host.ts";
import { IosDriver } from "./ios-driver.ts";
import { DeviceTargetService } from "./device-target-service.ts";
import { deviceBindings } from "./device-bindings.ts";
import { deviceProjectDirectory, syncDeviceBuildMirror, removeDeviceMirror } from "./device-build-mirror.ts";
import { installAxe } from "./device-tools.ts";
import { registerDeviceService, registerDeviceStory } from "./device-registry.ts";
import { localPreviewContext, localPreviewEndpoints } from "../preview-runtime/local/local-preview-runner.ts";
import { surfaceEnabled } from "../preview-surfaces/experimental-surfaces.ts";
import type { DeviceStory } from "./types.ts";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";

export type DeviceScope = { storyId: string; projectId: string; title?: string; worktree: string; targetId: string; workspaceMode?: DeviceStory["workspaceMode"] };
export class DeviceRuntime {
  readonly service: DeviceTargetService;
  private root = app.getPath("userData");
  private ios: IosDriver;
  private initialized: Promise<void>;
  private writes = Promise.resolve();
  private approvals = new Set<string>();
  private installations = new Map<string, Promise<void>>();
  constructor() {
    const pinned = join(this.root, "device-tools", "axe-1.8.0", "axe");
    const axe = existsSync(pinned) ? pinned : existsSync("/opt/homebrew/bin/axe") ? "/opt/homebrew/bin/axe" : "axe";
    this.ios = new IosDriver({ axe, cache: join(this.root, "device-frames") });
    this.service = new DeviceTargetService({
      drivers: [this.ios],
      mirror: (story) => syncDeviceBuildMirror(story, this.root),
      services: async (story, target) => {
        if (story.workspaceMode === "cloud-mirror") throw new Error("Device previews run on your computer. This story runs in the cloud.");
        const context = await localPreviewContext(story.worktree);
        if ((target.dependsOn?.length || target.bindings?.length) && story.workspaceMode !== "direct") {
          const { controlProjectPreview } = await import("../workspace-ipc.ts");
          await controlProjectPreview({ action: "start", worktree: story.worktree });
        }
        return deviceBindings(target, context.manifest, (await localPreviewEndpoints(story.worktree)).routes).environment;
      },
      prepare: async (story, target, signal, output) => {
        const cwd = await deviceProjectDirectory(story, target.projectDir);
        // VM installs contain Linux native modules. Host builds install their own.
        if (story.workspaceMode !== "direct" && (target.toolchain === "expo" || target.toolchain === "react-native")) {
          const command = existsSync(join(story.buildRoot, "pnpm-lock.yaml")) ? ["corepack", ["pnpm", "install", "--frozen-lockfile"]] as const : existsSync(join(story.buildRoot, "yarn.lock")) ? ["corepack", ["yarn", "install", "--immutable"]] as const : ["npm", ["ci"]] as const;
          await checked(deviceHost, command[0], [...command[1]], { cwd: story.buildRoot, environment: { ...story.environment, CI: "true" }, signal, output, timeoutMs: 15 * 60000 });
        }
        for (const command of target.prepare ?? []) await checked(deviceHost, process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], { cwd, environment: { ...story.environment, CI: "true" }, signal, output, timeoutMs: 15 * 60000 });
      },
      confirm: async (story) => {
        if (this.approvals.has(story.projectId)) return true;
        const result = await dialog.showMessageBox({ type: "question", title: "Build this app on your computer?", message: process.platform === "darwin" ? "Building this app runs the project's build scripts on your Mac." : "Building this app runs the project's build scripts on your computer.", detail: "Build scripts run without isolation, including dependency installation. Your story's source stays in its worktree.", buttons: ["Cancel", "Allow for this project"], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return false;
        this.approvals.add(story.projectId); await this.atomic("device-project-approvals.json", [...this.approvals]); return true;
      },
      persist: (records) => this.atomic("device-targets.json", records),
      removeMirror: (story) => removeDeviceMirror(this.root, story.projectId, story.id),
    });
    registerDeviceService(this.service);
    this.initialized = this.initialize();
    const timer = setInterval(() => { void this.service.shutdownIdle().catch(() => undefined); }, 60000); timer.unref();
  }
  private async initialize() {
    const approvals = await this.json("device-project-approvals.json");
    if (Array.isArray(approvals)) this.approvals = new Set(approvals.filter((v): v is string => typeof v === "string"));
    const records = await this.json("device-targets.json");
    if (Array.isArray(records)) {
      const valid = records.filter((r) => r && typeof r === "object" && r.story && r.target && typeof r.story.id === "string" && typeof r.story.worktree === "string");
      this.service.restore(valid);
      valid.forEach((r) => registerDeviceStory(r.story.id, r.story.worktree));
      const { pathExists } = await import("../workspace-runtime.ts");
      await this.service.cleanupOrphans(async (id) => { const record = valid.find((r) => r.story.id === id); return record ? pathExists(record.story.worktree).catch(() => undefined) : undefined; }).catch(() => undefined);
    }
  }
  async resolve(scope: DeviceScope) {
    await this.initialized;
    if (!scope || ![scope.storyId, scope.projectId, scope.targetId].every((s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(s)) || typeof scope.worktree !== "string") throw new Error("Device preview scope is invalid.");
    const context = await localPreviewContext(scope.worktree);
    const target = context.manifest.devices?.find((d) => d.id === scope.targetId);
    if (!target) throw new Error("Choose a device target in Preview Environment first.");
    const story: DeviceStory = { id: scope.storyId, projectId: scope.projectId, title: scope.title ?? scope.storyId, worktree: scope.worktree, buildRoot: scope.worktree, workspaceMode: scope.workspaceMode ?? "local-container" };
    registerDeviceStory(story.id, story.worktree);
    return { story, target };
  }
  async availability(scope: DeviceScope) {
    const { story, target } = await this.resolve(scope);
    if (!surfaceEnabled(target.platform)) return { status: "unavailable" as const, reason: "experimental_disabled" as const };
    return this.service.availability(story, target);
  }
  async start(scope: DeviceScope) {
    const availability = await this.availability(scope);
    if (availability.status !== "ready") return { status: "unavailable" as const, message: "This device cannot start here yet.", availability, logs: [] };
    const { story, target } = await this.resolve(scope);
    return this.service.start(story, target);
  }
  async prerequisite(scope: DeviceScope, id: string) {
    const availability = await this.availability(scope);
    const prerequisite = availability.status === "missing-prerequisites" ? availability.prerequisites.find((p) => p.id === id) : undefined;
    const action = prerequisite?.action;
    if (!action) return;
    if (action.type === "open-url") { await shell.openExternal(action.url); return; }
    if (action.type === "open-terminal") { await this.openTerminal(action.command); return; }
    const key = `${scope.projectId}:${id}`;
    if (this.installations.has(key)) return this.installations.get(key);
    const install = (async () => {
      const accepted = await dialog.showMessageBox({ type: "question", message: action.label, detail: id === "ios-runtime" ? "The iOS Simulator runtime downloads several GB. Xcode manages the download; its licenses must be accepted by you." : "Blame will download the pinned simulator controls into its app data folder and verify their checksum.", buttons: ["Cancel", "Download"], defaultId: 0, cancelId: 0 });
      if (accepted.response !== 1) return;
      if (id === "axe") this.ios.useAxe(await installAxe(this.root, deviceHost));
      else if (id === "ios-runtime") await checked(deviceHost, "xcodebuild", ["-downloadPlatform", "iOS"], { timeoutMs: 60 * 60000 });
    })().finally(() => this.installations.delete(key));
    this.installations.set(key, install); return install;
  }
  private async openTerminal(command: string) {
    const root = join(this.root, "device-tools"); await mkdir(root, { recursive: true });
    const file = join(root, process.platform === "win32" ? "setup.cmd" : "setup.command");
    await writeFile(file, process.platform === "win32" ? `@echo off\r\necho Run the following command to finish setup:\r\necho ${command}\r\npause\r\n${command}\r\npause\r\n` : `#!/bin/sh\nprintf '%s\\n' 'Press Enter to run the setup command. You may be asked for your password or license choices.'\nread answer\n${command}\nprintf '%s\\n' 'Press Enter to close.'\nread answer\n`, { mode: 0o700 });
    if (process.platform === "linux") { const child = deviceHost.spawn("x-terminal-emulator", ["-e", "/bin/sh", file]); child.on("error", () => undefined); child.unref(); }
    else { const error = await shell.openPath(file); if (error) throw new Error(error); }
  }
  private async json(file: string): Promise<any> { try { return JSON.parse(await readFile(join(this.root, file), "utf8")); } catch { return undefined; } }
  private atomic(file: string, value: unknown) { const operation = this.writes.then(() => this.writeAtomic(file, value)); this.writes = operation.catch(() => undefined); return operation; }
  private async writeAtomic(file: string, value: unknown) { await mkdir(this.root, { recursive: true }); const target = join(this.root, file), temporary = `${target}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, target); }
}
let runtime: DeviceRuntime | undefined;
export function deviceRuntime() { return runtime ??= new DeviceRuntime(); }
