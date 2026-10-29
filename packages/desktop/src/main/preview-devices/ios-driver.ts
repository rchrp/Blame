import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import {
  checked,
  commandLines,
  deviceHost,
  deviceName,
  type DeviceHost,
} from "./device-host.ts";
import {
  chooseIosDevice,
  compactIosUi,
  iosBuildArguments,
} from "./ios-parsers.ts";
import { failedDeviceBuild, parseXcodeBuildIssues } from "./build-errors.ts";
import { deviceProjectDirectory } from "./device-build-mirror.ts";
import { mjpegFrames } from "./frame-stream.ts";
import type {
  DeviceAvailability,
  DeviceBuildResult,
  DeviceDriver,
  DeviceHandle,
  DeviceInput,
  DevicePrerequisite,
  DeviceStory,
} from "./types.ts";
import { FlutterDeviceSession } from "./flutter-session.ts";

export class IosDriver implements DeviceDriver {
  readonly platform = "ios" as const;
  private host: DeviceHost;
  private axe: string;
  private os: NodeJS.Platform;
  private cache: string;
  private flutter = new Map<string, FlutterDeviceSession>();
  private xcodeApps: () => Promise<string[]>;
  private developerDir?: Promise<string | undefined>;
  private resolvedDeveloperDir?: string;
  constructor(options: {
    host?: DeviceHost;
    axe: string;
    cache: string;
    platform?: NodeJS.Platform;
    xcodeApps?: () => Promise<string[]>;
  }) {
    const base = options.host ?? deviceHost;
    this.xcodeApps = options.xcodeApps ?? installedXcodeApps;
    // Without a selected Xcode, Blame points its own commands at an installed
    // one, so the user never needs `sudo xcode-select`.
    this.host = {
      run: async (command, args, commandOptions = {}) =>
        base.run(command, args, {
          ...commandOptions,
          environment: withDeveloperDir(
            commandOptions.environment,
            await this.xcodeDeveloperDir(base),
          ),
        }),
      spawn: (command, args, commandOptions = {}) =>
        base.spawn(command, args, {
          ...commandOptions,
          environment: withDeveloperDir(
            commandOptions.environment,
            this.resolvedDeveloperDir,
          ),
        }),
    };
    this.axe = options.axe;
    this.cache = options.cache;
    this.os = options.platform ?? process.platform;
  }
  useAxe(path: string) {
    this.axe = path;
  }
  async availability(
    target?: PreviewManifestDeviceTarget,
  ): Promise<DeviceAvailability> {
    if (this.os !== "darwin")
      return { status: "unavailable", reason: "not_macos" };
    this.developerDir = undefined;
    const checks: DevicePrerequisite[] = [];
    const add = (
      id: string,
      title: string,
      done: boolean,
      action: DevicePrerequisite["action"],
      detail?: string,
    ) =>
      checks.push({
        id,
        title,
        status: done ? "done" : "missing",
        ...(done ? {} : { action, detail }),
      });
    const xcode = await this.host.run("xcodebuild", ["-version"], {
      timeoutMs: 10000,
    });
    add(
      "xcode-installed",
      "Xcode installed",
      xcode.exitCode === 0,
      { type: "open-url", url: "macappstore://apps.apple.com/app/id497799835" },
      "Install Xcode from the App Store.",
    );
    const firstLaunch = xcode.exitCode
      ? undefined
      : await this.host.run("xcodebuild", ["-checkFirstLaunchStatus"], {
          timeoutMs: 15000,
        });
    add(
      "xcode-first-launch",
      "License and first launch",
      firstLaunch?.exitCode === 0,
      { type: "open-terminal", command: "sudo xcodebuild -runFirstLaunch" },
    );
    const runtimes = xcode.exitCode
      ? undefined
      : await this.host.run("xcrun", ["simctl", "list", "runtimes", "--json"], {
          timeoutMs: 10000,
        });
    let hasRuntime = false;
    try {
      hasRuntime =
        JSON.parse(runtimes?.stdout ?? "{}").runtimes?.some(
          (r: { isAvailable: boolean; name: string }) =>
            r.isAvailable && /iOS/.test(r.name),
        ) === true;
    } catch {
      /* Show the runtime prerequisite. */
    }
    add("ios-runtime", "iOS simulator runtime", hasRuntime, {
      type: "install",
      label: "Download iOS runtime (several GB)",
    });
    const axe = await this.host.run(this.axe, ["--version"], {
      timeoutMs: 10000,
    });
    add(
      "axe",
      "Simulator controls",
      // A loader/framework failure must allow simctl's limited preview. A
      // missing executable (127) or an unsupported version still needs setup.
      (axe.exitCode === 0 && /\b1\.8\.0\b/.test(axe.stdout)) ||
        (axe.exitCode !== 0 && axe.exitCode !== 127),
      { type: "install", label: "Install simulator controls" },
    );
    if (target?.toolchain === "flutter") {
      const flutter = await this.host.run("flutter", ["--version"], {
        timeoutMs: 15000,
      });
      add("flutter", "Flutter installed", flutter.exitCode === 0, {
        type: "open-url",
        url: "https://docs.flutter.dev/get-started/install/macos",
      });
    }
    return checks.every((c) => c.status === "done")
      ? { status: "ready" }
      : { status: "missing-prerequisites", prerequisites: checks };
  }
  private xcodeDeveloperDir(base: DeviceHost) {
    this.developerDir ??= (async () => {
      const selected = await base.run("xcode-select", ["-p"], {
        timeoutMs: 10000,
      });
      if (
        selected.exitCode === 0 &&
        /Xcode[^/]*\.app\/Contents\/Developer/.test(selected.stdout)
      )
        return undefined;
      const [app] = await this.xcodeApps().catch(() => []);
      return app ? join(app, "Contents", "Developer") : undefined;
    })().then((directory) => (this.resolvedDeveloperDir = directory));
    return this.developerDir;
  }
  /** Downloads the iOS Simulator runtime with the Xcode Blame uses. */
  async downloadRuntime(output: (text: string) => void) {
    await checked(this.host, "xcodebuild", ["-downloadPlatform", "iOS"], {
      timeoutMs: 60 * 60000,
      output,
    });
  }
  async ensureDevice(
    story: DeviceStory,
    target: PreviewManifestDeviceTarget,
    signal?: AbortSignal,
  ): Promise<DeviceHandle> {
    const list = JSON.parse(
      await checked(this.host, "xcrun", ["simctl", "list", "--json"], {
        signal,
      }),
    );
    const { runtime, model } = chooseIosDevice(list, target);
    const existing =
      story.handle &&
      (Object.values(list.devices ?? {})
        .flat()
        .find((d) => (d as { udid: string }).udid === story.handle!.id) as
        { udid: string; state: string } | undefined);
    const id =
      existing?.udid ??
      (await checked(this.host, "xcrun", [
        "simctl",
        "create",
        deviceName(story),
        model.identifier,
        runtime.identifier,
      ]));
    try {
      signal?.throwIfAborted();
      if (existing?.state !== "Booted")
        await checked(this.host, "xcrun", ["simctl", "boot", id], { signal });
      await checked(this.host, "xcrun", ["simctl", "bootstatus", id, "-b"], {
        timeoutMs: 180000,
        signal,
      });
      const handle: DeviceHandle = {
        id,
        name: deviceName(story),
        platform: "ios",
        model: model.name,
        os: runtime.version,
        width: 0,
        height: 0,
        pointWidth: 390,
        pointHeight: 844,
      };
      await mkdir(this.cache, { recursive: true });
      const probe = join(this.cache, `${id}-probe.png`);
      const controls = await this.host.run(
        this.axe,
        ["screenshot", "--output", probe, "--udid", id],
        { timeoutMs: 15000, signal },
      );
      const frame = await readFile(probe).catch(() => Buffer.alloc(0));
      await rm(probe, { force: true });
      signal?.throwIfAborted();
      if (
        controls.exitCode ||
        frame.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      )
        handle.limited =
          "Limited preview: touches are unavailable with this Xcode version.";
      else await this.describeUi(handle).catch(() => undefined);
      return handle;
    } catch (error) {
      await this.host.run("xcrun", ["simctl", "shutdown", id], {
        timeoutMs: 10000,
      });
      if (!existing)
        await this.host.run("xcrun", ["simctl", "delete", id], {
          timeoutMs: 10000,
        });
      throw error;
    }
  }
  async build(
    story: DeviceStory,
    original: PreviewManifestDeviceTarget,
    progress: (step: string) => void,
    signal: AbortSignal,
  ): Promise<DeviceBuildResult> {
    const started = Date.now();
    let log = "";
    try {
      const directory = await deviceProjectDirectory(
        story,
        original.projectDir,
      );
      if (original.toolchain === "flutter") {
        if (!story.handle)
          throw new Error("Boot the simulator before starting Flutter.");
        let session = this.flutter.get(story.handle.id);
        if (!session) {
          session = new FlutterDeviceSession(this.host);
          this.flutter.set(story.handle.id, session);
        }
        return session.build(
          story,
          original,
          directory,
          story.handle.id,
          progress,
          signal,
        );
      }
      let target = structuredClone(original),
        cwd = directory;
      if (target.toolchain === "expo") {
        if (!target.prepare?.some((c) => /expo\s+prebuild/.test(c)))
          await checked(
            this.host,
            "npx",
            ["expo", "prebuild", "--platform", "ios"],
            {
              cwd,
              environment: { ...story.environment, CI: "true" },
              signal,
              timeoutMs: 600000,
            },
          );
        if (!target.build.workspace && !target.build.project) {
          cwd = join(directory, "ios");
          const workspace = (await readdir(cwd)).find((f) =>
            f.endsWith(".xcworkspace"),
          );
          if (!workspace)
            throw new Error(
              "Expo did not generate an Xcode workspace. Check the prebuild output.",
            );
          target.build.workspace = workspace;
          const schemes = JSON.parse(
            await checked(
              this.host,
              "xcodebuild",
              ["-list", "-json", "-workspace", workspace],
              { cwd, signal },
            ),
          );
          target.build.scheme ??=
            schemes.workspace?.schemes?.[0] ??
            basename(workspace, ".xcworkspace");
        }
      }
      const derived = join(story.buildRoot, ".blame", "DerivedData"),
        results = join(story.buildRoot, ".blame", "results");
      await mkdir(results, { recursive: true });
      const resultBundle = join(results, `${randomUUID()}.xcresult`);
      progress("Building the app");
      // xcodebuild needs the simulator destination but can build before boot finishes.
      const destination = story.handle?.id ?? "generic/platform=iOS Simulator";
      const args = iosBuildArguments(
        target,
        destination,
        derived,
        resultBundle,
      );
      if (!story.handle) args[args.indexOf("-destination") + 1] = destination;
      const result = await this.host.run("xcodebuild", args, {
        cwd,
        environment: { ...story.environment, CI: "true" },
        signal,
        timeoutMs: 20 * 60000,
        output: (text) => {
          log = (log + text).slice(-1000000);
        },
      });
      if (result.exitCode) {
        const issues = await this.host.run(
          "xcrun",
          ["xcresulttool", "get", "build-results", "--path", resultBundle],
          { timeoutMs: 15000 },
        );
        let parsed: ReturnType<typeof parseXcodeBuildIssues> = [];
        try {
          parsed = parseXcodeBuildIssues(
            JSON.parse(issues.stdout),
            story.buildRoot,
            story.worktree,
          );
        } catch {
          /* Older Xcode: retain compiler diagnostics. */
        }
        return failedDeviceBuild(
          `${log}\n${result.stdout}\n${result.stderr}\n${issues.stdout}`,
          story.buildRoot,
          story.worktree,
          parsed,
        );
      }
      const products = join(
        derived,
        "Build",
        "Products",
        `${target.build.configuration ?? "Debug"}-iphonesimulator`,
      );
      const apps = (await readdir(products)).filter((f) => f.endsWith(".app"));
      for (const app of apps) {
        const artifact = join(products, app);
        const bundleId = await checked(this.host, "plutil", [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          join(artifact, "Info.plist"),
        ]);
        if (bundleId === target.app.bundleId)
          return { ok: true, artifact, durationMs: Date.now() - started };
      }
      throw new Error(
        "The build produced no simulator app with the configured bundle identifier.",
      );
    } catch (error) {
      return failedDeviceBuild(
        `${log}\n${error instanceof Error ? error.message : error}`,
        story.buildRoot,
        story.worktree,
      );
    }
  }
  async install(handle: DeviceHandle, artifact: string) {
    if (artifact.startsWith("flutter:")) return;
    handle.executable = await checked(this.host, "plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      join(artifact, "Info.plist"),
    ]);
    await checked(this.host, "xcrun", [
      "simctl",
      "install",
      handle.id,
      artifact,
    ]);
  }
  async launch(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
    environment: Record<string, string>,
  ) {
    if (target.toolchain === "flutter") return;
    await checked(
      this.host,
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        handle.id,
        target.app.bundleId!,
      ],
      {
        environment: Object.fromEntries(
          Object.entries(environment).map(([key, value]) => [
            `SIMCTL_CHILD_${key}`,
            value,
          ]),
        ),
      },
    );
  }
  async terminate(handle: DeviceHandle, target: PreviewManifestDeviceTarget) {
    this.flutter.get(handle.id)?.close();
    this.flutter.delete(handle.id);
    await this.host.run("xcrun", [
      "simctl",
      "terminate",
      handle.id,
      target.app.bundleId!,
    ]);
  }
  async shutdown(handle: DeviceHandle) {
    this.flutter.get(handle.id)?.close();
    this.flutter.delete(handle.id);
    await this.host.run("xcrun", ["simctl", "shutdown", handle.id]);
  }
  async destroy(handle: DeviceHandle) {
    await this.shutdown(handle);
    await checked(this.host, "xcrun", ["simctl", "delete", handle.id]);
  }
  screen(handle: DeviceHandle) {
    const screenshot = async () => {
      const file = join(this.cache, `${handle.id}-${randomUUID()}.png`);
      await checked(this.host, "xcrun", [
        "simctl",
        "io",
        handle.id,
        "screenshot",
        file,
      ]);
      try {
        return await readFile(file);
      } finally {
        await rm(file, { force: true });
      }
    };
    const host = this.host,
      axe = this.axe;
    return {
      screenshot,
      async *frames(signal: AbortSignal) {
        if (!handle.limited) {
          const child = host.spawn(
            axe,
            [
              "stream-video",
              "--format",
              "mjpeg",
              "--fps",
              "15",
              "--quality",
              "70",
              "--udid",
              handle.id,
            ],
            { signal },
          );
          child.stderr.resume();
          child.on("error", () => undefined);
          let any = false;
          let watchdog = setTimeout(() => child.kill(), 5000);
          try {
            for await (const data of mjpegFrames(child.stdout)) {
              clearTimeout(watchdog);
              watchdog = setTimeout(() => child.kill(), 5000);
              any = true;
              yield {
                data,
                width: handle.width,
                height: handle.height,
                pointWidth: handle.pointWidth,
                pointHeight: handle.pointHeight,
              };
            }
          } catch {
            /* Fall back to simctl polling. */
          } finally {
            clearTimeout(watchdog);
            child.kill();
          }
          if (!signal.aborted)
            handle.limited =
              "Limited preview: touches are unavailable with this Xcode version.";
          if (!any && signal.aborted) return;
        }
        while (!signal.aborted) {
          const data = await screenshot();
          yield {
            data,
            width: handle.width,
            height: handle.height,
            pointWidth: handle.pointWidth,
            pointHeight: handle.pointHeight,
          };
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
    };
  }
  input(handle: DeviceHandle): DeviceInput {
    const axe = async (args: string[]) => {
      if (handle.limited) throw new Error(handle.limited);
      await checked(
        this.host,
        this.axe,
        args.includes("--udid") ? args : [...args, "--udid", handle.id],
      );
    };
    const keycodes: Record<string, string> = {
      Enter: "40",
      Backspace: "42",
      Tab: "43",
      Escape: "41",
      ArrowRight: "79",
      ArrowLeft: "80",
      ArrowDown: "81",
      ArrowUp: "82",
    };
    return {
      tap: (x, y) => axe(["tap", "-x", String(x), "-y", String(y)]),
      swipe: (x, y, toX, toY) =>
        axe([
          "swipe",
          "--start-x",
          String(x),
          "--start-y",
          String(y),
          "--end-x",
          String(toX),
          "--end-y",
          String(toY),
        ]),
      type: (text) => axe(["type", "--udid", handle.id, "--", text]),
      key: async (key) => {
        if (!keycodes[key])
          throw new Error("This key is unavailable on the simulator.");
        await axe(["key", keycodes[key]!]);
      },
      button: async (button) => {
        if (!["home", "lock"].includes(button))
          throw new Error("This button is unavailable on the simulator.");
        await axe(["button", button]);
      },
      openUrl: async (url) => {
        await checked(this.host, "xcrun", [
          "simctl",
          "openurl",
          handle.id,
          url,
        ]);
      },
      appearance: async (value) => {
        await checked(this.host, "xcrun", [
          "simctl",
          "ui",
          handle.id,
          "appearance",
          value,
        ]);
      },
    };
  }
  async describeUi(handle: DeviceHandle) {
    if (handle.limited) return [];
    const nodes = compactIosUi(
      JSON.parse(
        await checked(this.host, this.axe, [
          "describe-ui",
          "--udid",
          handle.id,
        ]),
      ),
    );
    const root = nodes[0]?.frame;
    if (root && root.width > 0 && root.height > 0) {
      handle.pointWidth = root.width;
      handle.pointHeight = root.height;
    }
    return nodes;
  }
  async *logs(
    handle: DeviceHandle,
    _target: PreviewManifestDeviceTarget,
    signal: AbortSignal,
  ) {
    const flutter = this.flutter.get(handle.id);
    if (flutter) {
      yield* flutter.logs(signal);
      return;
    }
    const executable = (handle.executable ?? "").replace(/["\\]/g, "");
    if (!executable) return;
    const child = this.host.spawn(
      "xcrun",
      [
        "simctl",
        "spawn",
        handle.id,
        "log",
        "stream",
        "--style",
        "compact",
        "--predicate",
        `process == "${executable}"`,
      ],
      { signal },
    );
    child.stderr.resume();
    yield* commandLines(child);
  }
  async ownedDevices() {
    if (this.os !== "darwin") return [];
    const list = JSON.parse(
      await checked(this.host, "xcrun", [
        "simctl",
        "list",
        "devices",
        "--json",
      ]),
    );
    return (
      Object.values(list.devices ?? {}).flat() as Array<{
        name: string;
        udid: string;
      }>
    )
      .filter((d) => d.name.startsWith("Blame · "))
      .map((d): DeviceHandle => ({
        id: d.udid,
        name: d.name,
        platform: "ios",
        os: "",
        model: "",
        width: 0,
        height: 0,
        pointWidth: 390,
        pointHeight: 844,
      }));
  }
}

function withDeveloperDir(
  environment: Record<string, string> | undefined,
  developerDir: string | undefined,
) {
  return developerDir
    ? { DEVELOPER_DIR: developerDir, ...environment }
    : environment;
}

/** Installed Xcode apps, the stable "Xcode.app" first. */
async function installedXcodeApps() {
  const apps = (await readdir("/Applications")).filter((name) =>
    /^Xcode.*\.app$/.test(name),
  );
  return apps
    .sort((a, b) =>
      a === "Xcode.app" ? -1 : b === "Xcode.app" ? 1 : a.localeCompare(b),
    )
    .map((name) => join("/Applications", name));
}
