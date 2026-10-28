import { AndroidDriver } from "./android-driver.ts";
import { androidTool, androidSystemImage, androidAbi } from "./android-sdk.ts";
import { installAndroidTools } from "./android-tools.ts";
import { randomUUID } from "node:crypto";
import { app, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceHost, checked } from "./device-host.ts";
import { IosDriver } from "./ios-driver.ts";
import { DeviceTargetService } from "./device-target-service.ts";
import { deviceBindings } from "./device-bindings.ts";
import {
  deviceProjectDirectory,
  syncDeviceBuildMirror,
  removeDeviceMirror,
} from "./device-build-mirror.ts";
import { installAxe } from "./device-tools.ts";
import {
  registerDeviceService,
  registerDeviceStory,
} from "./device-registry.ts";
import {
  localPreviewContext,
  localPreviewEndpoints,
} from "../preview-runtime/local/local-preview-runner.ts";
import { surfaceEnabled } from "../preview-surfaces/experimental-surfaces.ts";
import type { DeviceStory } from "./types.ts";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import {
  parsePreviewManifest,
  type PreviewManifest,
} from "@blame/preview-contract";

export type DeviceScope = {
  storyId: string;
  projectId: string;
  title?: string;
  worktree: string;
  targetId: string;
  workspaceMode?: DeviceStory["workspaceMode"];
  manifest?: PreviewManifest;
};
export class DeviceRuntime {
  readonly service: DeviceTargetService;
  private root = app.getPath("userData");
  private ios: IosDriver;
  private android: AndroidDriver;
  private initialized: Promise<void>;
  private writes = Promise.resolve();
  private approvals = new Set<string>();
  private installSteps = new Map<string, { label: string; logs: string[] }>();
  private installations = new Map<string, Promise<void>>();
  private directManifests = new Map<string, PreviewManifest>();
  constructor() {
    const pinned = join(this.root, "device-tools", "axe-1.8.0", "axe");
    const axe = existsSync(pinned)
      ? pinned
      : existsSync("/opt/homebrew/bin/axe")
        ? "/opt/homebrew/bin/axe"
        : "axe";
    this.ios = new IosDriver({ axe, cache: join(this.root, "device-frames") });
    this.android = new AndroidDriver({ root: this.root });
    this.service = new DeviceTargetService({
      drivers: [this.ios, this.android],
      mirror: (story) => syncDeviceBuildMirror(story, this.root),
      services: async (story, target) => {
        if (story.workspaceMode === "cloud-mirror")
          throw new Error(
            "Device previews run on your computer. This story runs in the cloud.",
          );
        const directManifest = this.directManifests.get(story.id);
        const manifest =
          directManifest ??
          (await localPreviewContext(story.worktree)).manifest;
        if (target.dependsOn?.length || target.bindings?.length) {
          if (directManifest) {
            const { writeLocalPreviewInitialization } =
              await import("../preview-runtime/local/local-preview-files.ts");
            const configuration = {
              id: `device-${target.id}`,
              name: target.id,
              category: "mobile" as const,
              command: "true",
              cwd: ".",
              default: true,
              scopes: [],
              services: [
                ...new Set([
                  ...(target.dependsOn ?? []),
                  ...(target.bindings ?? []).map((b) => b.source.service),
                ]),
              ],
              previewTarget: target.id,
            };
            await writeLocalPreviewInitialization(
              story.worktree,
              directManifest,
              [configuration],
              configuration.id,
            );
          }
          const { controlProjectPreview } = await import("../workspace-ipc.ts");
          await controlProjectPreview({
            action: "start",
            worktree: story.worktree,
          });
        }
        const bindings = deviceBindings(
          target,
          manifest,
          target.dependsOn?.length || target.bindings?.length
            ? (await localPreviewEndpoints(story.worktree)).routes
            : [],
        );
        if (target.platform === "android") {
          this.android.setBindings(story.id, bindings.reverse);
          return { ...this.android.environment(), ...bindings.environment };
        }
        return bindings.environment;
      },
      prepare: async (story, target, signal, output) => {
        const cwd = await deviceProjectDirectory(story, target.projectDir);
        // VM installs contain Linux native modules. Host builds install their own.
        if (
          story.workspaceMode !== "direct" &&
          (target.toolchain === "expo" || target.toolchain === "react-native")
        ) {
          const command = existsSync(join(story.buildRoot, "pnpm-lock.yaml"))
            ? (["corepack", ["pnpm", "install", "--frozen-lockfile"]] as const)
            : existsSync(join(story.buildRoot, "yarn.lock"))
              ? ([
                  "corepack",
                  [
                    "yarn",
                    "install",
                    (
                      await readFile(join(story.buildRoot, "yarn.lock"), "utf8")
                    ).startsWith("# yarn lockfile v1")
                      ? "--frozen-lockfile"
                      : "--immutable",
                  ],
                ] as const)
              : ([
                  "npm",
                  [
                    existsSync(join(story.buildRoot, "package-lock.json"))
                      ? "ci"
                      : "install",
                  ],
                ] as const);
          await checked(deviceHost, command[0], [...command[1]], {
            cwd: story.buildRoot,
            environment: { ...story.environment, CI: "true" },
            signal,
            output,
            timeoutMs: 15 * 60000,
          });
        }
        for (const command of target.prepare ?? [])
          await checked(
            deviceHost,
            process.platform === "win32" ? "cmd.exe" : "/bin/sh",
            process.platform === "win32"
              ? ["/d", "/s", "/c", command]
              : ["-lc", command],
            {
              cwd,
              environment: { ...story.environment, CI: "true" },
              signal,
              output,
              timeoutMs: 15 * 60000,
            },
          );
      },
      confirm: async (story) => {
        if (this.approvals.has(story.projectId)) return true;
        const result = await dialog.showMessageBox({
          type: "question",
          title: "Build this app on your computer?",
          message:
            process.platform === "darwin"
              ? "Building this app runs the project's build scripts on your Mac."
              : "Building this app runs the project's build scripts on your computer.",
          detail:
            "Build scripts run without isolation, including dependency installation. Your story's source stays in its worktree.",
          buttons: ["Cancel", "Allow for this project"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return false;
        this.approvals.add(story.projectId);
        await this.atomic("device-project-approvals.json", [...this.approvals]);
        return true;
      },
      persist: (records) => this.atomic("device-targets.json", records),
      removeMirror: (story) =>
        removeDeviceMirror(this.root, story.projectId, story.id),
    });
    registerDeviceService(this.service);
    this.initialized = this.initialize();
    const timer = setInterval(() => {
      void this.service.shutdownIdle().catch(() => undefined);
    }, 60000);
    timer.unref();
  }
  private async initialize() {
    const approvals = await this.json("device-project-approvals.json");
    if (Array.isArray(approvals))
      this.approvals = new Set(
        approvals.filter((v): v is string => typeof v === "string"),
      );
    const records = await this.json("device-targets.json");
    const valid = Array.isArray(records)
      ? records.filter(
          (r) =>
            r &&
            typeof r === "object" &&
            r.story &&
            r.target &&
            typeof r.story.id === "string" &&
            typeof r.story.worktree === "string" &&
            (r.target.platform === "ios" || r.target.platform === "android"),
        )
      : [];
    this.service.restore(valid);
    valid.forEach((r) => registerDeviceStory(r.story.id, r.story.worktree));
    const { pathExists } = await import("../workspace-runtime.ts");
    await this.service
      .cleanupOrphans(async (id) => {
        const record = valid.find((r) => r.story.id === id);
        return record
          ? pathExists(record.story.worktree).catch(() => undefined)
          : undefined;
      })
      .catch(() => undefined);
  }

  async resolve(scope: DeviceScope) {
    await this.initialized;
    if (
      !scope ||
      ![scope.storyId, scope.projectId, scope.targetId].every(
        (s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(s),
      ) ||
      typeof scope.worktree !== "string"
    )
      throw new Error("Device preview scope is invalid.");
    const manifest =
      scope.workspaceMode === "direct" && scope.manifest
        ? parsePreviewManifest(scope.manifest)
        : (await localPreviewContext(scope.worktree)).manifest;
    if (scope.workspaceMode === "direct")
      this.directManifests.set(scope.storyId, manifest);
    const target = manifest.devices?.find((d) => d.id === scope.targetId);
    if (!target)
      throw new Error("Choose a device target in Preview Environment first.");
    const story: DeviceStory = {
      id: scope.storyId,
      projectId: scope.projectId,
      title: scope.title ?? scope.storyId,
      worktree: scope.worktree,
      buildRoot: scope.worktree,
      workspaceMode: scope.workspaceMode ?? "local-container",
    };
    registerDeviceStory(story.id, story.worktree);
    return { story, target };
  }
  async availability(scope: DeviceScope) {
    if (scope?.workspaceMode === "cloud-mirror")
      return { status: "unavailable" as const, reason: "cloud_story" as const };
    const { story, target } = await this.resolve(scope);
    if (!surfaceEnabled(target.platform))
      return {
        status: "unavailable" as const,
        reason: "experimental_disabled" as const,
      };
    const availability = await this.service.availability(story, target),
      installing = this.installSteps.get(story.id);
    if (installing)
      return {
        status: "missing-prerequisites" as const,
        prerequisites: [
          ...(availability.status === "missing-prerequisites"
            ? availability.prerequisites
            : []),
          {
            id: "installing",
            title: installing.label,
            status: "checking" as const,
          },
        ],
      };
    return availability;
  }
  state(storyId: string) {
    const installing = this.installSteps.get(storyId);
    return installing
      ? {
          ...this.service.status(storyId),
          status: "starting",
          step: installing.label,
          message: installing.label,
          logs: installing.logs,
        }
      : this.service.status(storyId);
  }
  async start(scope: DeviceScope) {
    const availability = await this.availability(scope);
    if (availability.status !== "ready")
      return {
        status: "unavailable" as const,
        message: "This device cannot start here yet.",
        availability,
        logs: [],
      };
    const { story, target } = await this.resolve(scope);
    return this.service.start(story, target);
  }
  async prerequisite(scope: DeviceScope, id: string) {
    const { target } = await this.resolve(scope);
    const availability = await this.availability(scope);
    const prerequisite =
      availability.status === "missing-prerequisites"
        ? availability.prerequisites.find((p) => p.id === id)
        : undefined;
    const action = prerequisite?.action;
    if (!action) return;
    if (action.type === "open-url") {
      await shell.openExternal(action.url);
      return;
    }
    if (action.type === "open-terminal") {
      await this.openTerminal(action.command);
      return;
    }
    const key = `${scope.projectId}:${id}`;
    if (this.installations.has(key)) return this.installations.get(key);
    const install = (async () => {
      const accepted = await dialog.showMessageBox({
        type: "question",
        message: action.label,
        detail:
          id === "ios-runtime"
            ? "The iOS Simulator runtime downloads several GB. Xcode manages the download; its licenses must be accepted by you."
            : id === "android-packages"
              ? "The emulator and system image download several GB using the Android SDK Manager. Accept the SDK licenses yourself before continuing."
              : "Blame will download the pinned device tools into its app data folder and verify their checksum.",
        buttons: ["Cancel", "Download"],
        defaultId: 0,
        cancelId: 0,
      });
      if (accepted.response !== 1) return;
      const progress = { label: action.label, logs: [] as string[] };
      this.installSteps.set(scope.storyId, progress);
      const output = (text: string) => {
        progress.logs = [...progress.logs, ...text.split(/\r?\n/)].slice(-200);
      };
      if (id === "android-sdk")
        await installAndroidTools(this.root, deviceHost);
      else if (id === "android-packages") {
        const root = this.android.sdkRoot();
        if (!existsSync(join(root, "licenses/android-sdk-license")))
          throw new Error(
            "Read and accept the Android SDK licenses in the terminal first.",
          );
        await checked(
          deviceHost,
          androidTool(root, "sdkmanager"),
          [
            `--sdk_root=${root}`,
            "emulator",
            "platform-tools",
            androidSystemImage(
              target.device?.os,
              androidAbi(process.platform, process.arch),
            ),
          ],
          {
            environment: this.android.environment(),
            timeoutMs: 60 * 60000,
            output,
          },
        );
      } else if (id === "axe")
        this.ios.useAxe(await installAxe(this.root, deviceHost));
      else if (id === "ios-runtime")
        await checked(deviceHost, "xcodebuild", ["-downloadPlatform", "iOS"], {
          timeoutMs: 60 * 60000,
          output,
        });
    })().finally(() => {
      this.installations.delete(key);
      this.installSteps.delete(scope.storyId);
    });
    this.installations.set(key, install);
    return install;
  }
  private async openTerminal(command: string) {
    const root = join(this.root, "device-tools");
    await mkdir(root, { recursive: true });
    const file = join(
      root,
      process.platform === "win32" ? "setup.cmd" : "setup.command",
    );
    await writeFile(
      file,
      process.platform === "win32"
        ? `@echo off\r\necho Run the following command to finish setup:\r\necho ${command}\r\npause\r\n${command}\r\npause\r\n`
        : `#!/bin/sh\nprintf '%s\\n' 'Press Enter to run the setup command. You may be asked for your password or license choices.'\nread answer\n${command}\nprintf '%s\\n' 'Press Enter to close.'\nread answer\n`,
      { mode: 0o700 },
    );
    if (process.platform === "linux") {
      const child = deviceHost.spawn("x-terminal-emulator", [
        "-e",
        "/bin/sh",
        file,
      ]);
      child.on("error", () => undefined);
      child.unref();
    } else {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    }
  }
  private async json(file: string): Promise<any> {
    try {
      return JSON.parse(await readFile(join(this.root, file), "utf8"));
    } catch {
      return undefined;
    }
  }
  private atomic(file: string, value: unknown) {
    const operation = this.writes.then(() => this.writeAtomic(file, value));
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private async writeAtomic(file: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, file),
      temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, target);
  }
}
let runtime: DeviceRuntime | undefined;
export function deviceRuntime() {
  return (runtime ??= new DeviceRuntime());
}
