import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import {
  deviceHost,
  checked,
  commandLines,
  captureDeviceBytes,
  deviceName,
  type DeviceHost,
} from "./device-host.ts";
import {
  detectAndroidSdk,
  androidTool,
  androidAbi,
  androidSystemImage,
} from "./android-sdk.ts";
import {
  androidBuildArguments,
  androidEmulatorArguments,
  androidUiNodes,
} from "./android-parsers.ts";
import { AndroidGrpc, androidDiscovery } from "./android-grpc.ts";
import { deviceProjectDirectory } from "./device-build-mirror.ts";
import { failedDeviceBuild } from "./build-errors.ts";
import { FlutterDeviceSession } from "./flutter-session.ts";
import type {
  DeviceAvailability,
  DeviceBuildResult,
  DeviceDriver,
  DeviceHandle,
  DeviceInput,
  DevicePrerequisite,
  DeviceStory,
} from "./types.ts";

export class AndroidDriver implements DeviceDriver {
  readonly platform = "android" as const;
  private host: DeviceHost;
  private root: string;
  private os: NodeJS.Platform;
  private arch: string;
  private home: string;
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private grpc = new Map<string, AndroidGrpc>();
  private flutter = new Map<string, FlutterDeviceSession>();
  private forwards = new Map<
    string,
    Array<{ devicePort: number; hostPort: number }>
  >();
  private creatingAvd = new Map<string, Promise<void>>();
  constructor(options: {
    host?: DeviceHost;
    root: string;
    platform?: NodeJS.Platform;
    arch?: string;
    home?: string;
  }) {
    this.host = options.host ?? deviceHost;
    this.root = options.root;
    this.os = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.home = options.home ?? homedir();
  }
  sdkRoot() {
    return detectAndroidSdk(this.os, this.home, this.root);
  }
  environment() {
    return {
      ANDROID_HOME: this.sdkRoot(),
      ANDROID_SDK_ROOT: this.sdkRoot(),
      ANDROID_AVD_HOME: join(this.root, "android-avds"),
      ANDROID_EMULATOR_HOME: join(this.root, "android-emulator"),
      GRADLE_USER_HOME: join(this.root, "gradle"),
      ...(this.javaHome() ? { JAVA_HOME: this.javaHome()! } : {}),
    };
  }
  setBindings(
    storyId: string,
    reverse: Array<{ devicePort: number; hostPort: number }>,
  ) {
    this.forwards.set(storyId, reverse);
  }
  private javaHome() {
    const candidates = [
      process.env.JAVA_HOME,
      this.os === "darwin"
        ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
        : this.os === "win32"
          ? join(
              process.env.ProgramFiles ?? "C:\\Program Files",
              "Android/Android Studio/jbr",
            )
          : "/opt/android-studio/jbr",
    ];
    return candidates.find(
      (p) =>
        p &&
        existsSync(join(p, "bin", this.os === "win32" ? "java.exe" : "java")),
    );
  }
  async availability(
    target?: PreviewManifestDeviceTarget,
  ): Promise<DeviceAvailability> {
    if (this.arch !== "x64" && !(this.os === "darwin" && this.arch === "arm64"))
      return { status: "unavailable", reason: "unsupported_arch" };
    const root = this.sdkRoot(),
      sdkmanager = androidTool(root, "sdkmanager", this.os),
      adb = androidTool(root, "adb", this.os),
      emulator = androidTool(root, "emulator", this.os),
      image = androidSystemImage(
        target?.device?.os,
        androidAbi(this.os, this.arch),
      );
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
    add("android-sdk", "Android SDK", existsSync(sdkmanager), {
      type: "install",
      label: "Download Android command-line tools (about 180 MB)",
    });
    add(
      "android-licenses",
      "Android SDK licenses",
      existsSync(join(root, "licenses/android-sdk-license")),
      {
        type: "open-terminal",
        command:
          this.os === "win32"
            ? `"${sdkmanager}" --sdk_root="${root}" --licenses`
            : `${quote(sdkmanager)} --sdk_root=${quote(root)} --licenses`,
      },
      "Read and accept the SDK licenses yourself in the terminal.",
    );
    add(
      "android-packages",
      "Emulator, platform tools and system image",
      existsSync(adb) &&
        existsSync(emulator) &&
        existsSync(join(root, ...image.split(";"))),
      {
        type: "install",
        label: "Download emulator and Android image (several GB)",
      },
    );
    const accel = existsSync(emulator)
      ? await this.host.run(emulator, ["-accel-check"], {
          environment: this.environment(),
          timeoutMs: 15000,
        })
      : undefined;
    const kvm =
      this.os !== "linux" ||
      (await access("/dev/kvm", constants.R_OK | constants.W_OK).then(
        () => true,
        () => false,
      ));
    add(
      "android-acceleration",
      "Hardware acceleration",
      accel?.exitCode === 0 && kvm,
      {
        type: "open-url",
        url: "https://developer.android.com/studio/run/emulator-acceleration",
      },
      this.os === "linux"
        ? "Enable virtualization and give your user access to /dev/kvm (the kvm group), then sign in again."
        : "Enable hardware virtualization for the Android Emulator.",
    );
    const java = await this.host.run(
      this.javaHome()
        ? join(
            this.javaHome()!,
            "bin",
            this.os === "win32" ? "java.exe" : "java",
          )
        : "java",
      ["-version"],
      { timeoutMs: 10000 },
    );
    add(
      "android-java",
      "Java installed",
      java.exitCode === 0 &&
        /(?:version\s+"?|openjdk\s+)(?:17|21)(?:[.\s"])/i.test(
          java.stdout + java.stderr,
        ),
      { type: "open-url", url: "https://adoptium.net/temurin/releases/" },
      "Use JDK 17 or 21 to match this project's Android Gradle Plugin.",
    );
    if (target?.toolchain === "flutter") {
      const flutter = await this.host.run("flutter", ["--version"], {
        timeoutMs: 15000,
      });
      add("flutter", "Flutter installed", flutter.exitCode === 0, {
        type: "open-url",
        url: "https://docs.flutter.dev/get-started/install",
      });
    }
    return checks.every((c) => c.status === "done")
      ? { status: "ready" }
      : { status: "missing-prerequisites", prerequisites: checks };
  }
  async ensureDevice(
    story: DeviceStory,
    target: PreviewManifestDeviceTarget,
    signal?: AbortSignal,
  ): Promise<DeviceHandle> {
    signal?.throwIfAborted();
    const root = this.sdkRoot(),
      environment = this.environment(),
      image = androidSystemImage(
        target.device?.os,
        androidAbi(this.os, this.arch),
      );
    const avd = `Blame_Phone_${target.device?.os ?? "35"}_${androidAbi(this.os, this.arch)}`;
    await mkdir(environment.ANDROID_AVD_HOME, { recursive: true });
    await mkdir(environment.ANDROID_EMULATOR_HOME, { recursive: true });
    if (!existsSync(join(environment.ANDROID_AVD_HOME, `${avd}.avd`))) {
      let creating = this.creatingAvd.get(avd);
      if (!creating) {
        creating = (async () => {
          const manager = androidTool(root, "avdmanager", this.os),
            devices = (
              await this.host.run(manager, ["list", "device", "-c"], {
                environment,
              })
            ).stdout.split(/\r?\n/);
          const requested = (target.device?.model ?? "Pixel 9")
            .toLowerCase()
            .replace(/\s+/g, "_");
          const model = devices.includes(requested)
            ? requested
            : (devices.find((d) => /^pixel(?:_\d+)?$/.test(d)) ?? "pixel");
          await checked(
            this.host,
            manager,
            [
              "create",
              "avd",
              "--name",
              avd,
              "--package",
              image,
              "--device",
              model,
            ],
            { environment, input: "no\n" },
          );
        })().finally(() => this.creatingAvd.delete(avd));
        this.creatingAvd.set(avd, creating);
      }
      await creating;
    }
    let handle = story.handle;
    const child = handle && this.children.get(handle.id);
    const reusable =
      handle &&
      child &&
      child.exitCode === null &&
      !child.killed &&
      child.pid === handle.processId &&
      (await this.ownsDevice(handle));
    if (!handle || !reusable) {
      signal?.throwIfAborted();
      const port = await emulatorPort(),
        grpcPort = await freePort();
      const child = this.host.spawn(
        androidTool(root, "emulator", this.os),
        androidEmulatorArguments(avd, port, grpcPort),
        { environment },
      );
      child.stdout.resume();
      child.stderr.resume();
      child.on("error", () => undefined);
      handle = {
        id: `emulator-${port}`,
        platform: "android",
        name: deviceName(story),
        os: target.device?.os ?? "35",
        model: target.device?.model ?? "Pixel",
        port,
        grpcPort,
        processId: child.pid,
        width: 1080,
        height: 2400,
        pointWidth: 360,
        pointHeight: 800,
      };
      this.children.set(handle.id, child);
    }
    try {
      await checked(
        this.host,
        androidTool(root, "adb", this.os),
        ["-s", handle.id, "wait-for-device"],
        { timeoutMs: 180000, signal },
      );
      const deadline = Date.now() + 180000;
      while (
        (
          await this.adb(handle, ["shell", "getprop sys.boot_completed"])
        ).stdout.trim() !== "1"
      ) {
        signal?.throwIfAborted();
        if (Date.now() > deadline)
          throw new Error(
            "The Android emulator did not finish booting. Check hardware acceleration and try again.",
          );
        await new Promise((r) => setTimeout(r, 1000));
      }
      signal?.throwIfAborted();
      for (const mapping of this.forwards.get(story.id) ?? [])
        await this.adbChecked(handle, [
          "reverse",
          `tcp:${mapping.devicePort}`,
          `tcp:${mapping.hostPort}`,
        ]);
      const size = (await this.adb(handle, ["shell", "wm size"])).stdout.match(
          /(\d+)x(\d+)/,
        ),
        density = (
          await this.adb(handle, ["shell", "wm density"])
        ).stdout.match(/density:\s*(\d+)/i);
      if (size) {
        handle.width = Number(size[1]);
        handle.height = Number(size[2]);
      }
      const scale = Number(density?.[1] ?? 480) / 160;
      handle.pointWidth = handle.width / scale;
      handle.pointHeight = handle.height / scale;
      const grpc = await this.connectGrpc(handle);
      if (grpc) this.grpc.set(handle.id, grpc);
      else
        handle.limited =
          "Using compatibility screen capture for this emulator.";
      return handle;
    } catch (error) {
      await this.shutdown(handle).catch(() => undefined);
      throw error;
    }
  }
  private async connectGrpc(handle: DeviceHandle) {
    if (!handle.grpcPort) return;
    const directories = [
      join(this.environment().ANDROID_EMULATOR_HOME, "avd/running"),
      join(this.home, ".android/avd/running"),
      join(this.home, "Library/Android/avd/running"),
    ];
    for (const directory of directories)
      for (const file of (await readdir(directory).catch(() => []))
        .filter((f) => /^pid_\d+\.ini$/.test(f))
        .slice(0, 50)) {
        const discovery = androidDiscovery(
          await readFile(join(directory, file), "utf8"),
          handle.grpcPort,
        );
        if (!discovery) continue;
        const client = new AndroidGrpc(discovery.port, discovery.token);
        try {
          await client.screenshot();
          return client;
        } catch {
          client.close();
        }
      }
  }
  async build(
    story: DeviceStory,
    target: PreviewManifestDeviceTarget,
    progress: (step: string) => void,
    signal: AbortSignal,
  ): Promise<DeviceBuildResult> {
    const started = Date.now();
    let log = "";
    try {
      let cwd = await deviceProjectDirectory(story, target.projectDir);
      const environment = {
        ...this.environment(),
        ...story.environment,
        CI: "true",
      };
      if (target.toolchain === "flutter") {
        if (!story.handle)
          throw new Error("Boot the emulator before starting Flutter.");
        let session = this.flutter.get(story.handle.id);
        if (!session) {
          session = new FlutterDeviceSession(this.host);
          this.flutter.set(story.handle.id, session);
        }
        return session.build(
          { ...story, environment },
          target,
          cwd,
          story.handle.id,
          progress,
          signal,
        );
      }
      if (
        target.toolchain === "expo" &&
        !target.prepare?.some((c) => /expo\s+prebuild/.test(c))
      )
        await checked(
          this.host,
          "npx",
          ["expo", "prebuild", "--platform", "android", "--no-install"],
          { cwd, environment, signal, timeoutMs: 600000 },
        );
      if (
        (target.toolchain === "expo" || target.toolchain === "react-native") &&
        existsSync(join(cwd, "android"))
      )
        cwd = join(cwd, "android");
      progress("Building the app");
      const gradle = this.os === "win32" ? "gradlew.bat" : "./gradlew";
      const result = await this.host.run(
        gradle,
        androidBuildArguments(target),
        {
          cwd,
          environment,
          signal,
          timeoutMs: 20 * 60000,
          output: (text) => {
            log = (log + text).slice(-1000000);
          },
        },
      );
      if (result.exitCode)
        return failedDeviceBuild(
          log + "\n" + result.stderr + "\n" + result.stdout,
          story.buildRoot,
          story.worktree,
        );
      const output = join(
        cwd,
        ...(target.build.module ?? "app").split(":").filter(Boolean),
        "build/outputs/apk",
      );
      const apks = await findApks(output),
        variant = (target.build.variant ?? "debug").toLowerCase();
      const artifact =
        apks.find(
          (f) => f.toLowerCase().includes(variant) && /universal/.test(f),
        ) ?? apks.find((f) => f.toLowerCase().includes(variant));
      if (!artifact)
        throw new Error(
          "The Gradle build produced no APK for the configured variant.",
        );
      return { ok: true, artifact, durationMs: Date.now() - started };
    } catch (error) {
      return failedDeviceBuild(
        log + "\n" + String(error),
        story.buildRoot,
        story.worktree,
      );
    }
  }
  async install(handle: DeviceHandle, artifact: string) {
    if (!artifact.startsWith("flutter:"))
      await this.adbChecked(handle, ["install", "-r", artifact], 180000);
  }
  async launch(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
    _environment: Record<string, string>,
  ) {
    if (target.toolchain === "flutter") return;
    if (target.app.launchActivity)
      await this.shell(handle, [
        "am",
        "start",
        "-n",
        `${target.app.applicationId}/${target.app.launchActivity}`,
      ]);
    else
      await this.shell(handle, [
        "monkey",
        "-p",
        target.app.applicationId!,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ]);
  }
  async terminate(handle: DeviceHandle, target: PreviewManifestDeviceTarget) {
    this.flutter.get(handle.id)?.close();
    this.flutter.delete(handle.id);
    if (await this.ownsDevice(handle))
      await this.shell(handle, ["am", "force-stop", target.app.applicationId!]);
  }
  async shutdown(handle: DeviceHandle) {
    this.grpc.get(handle.id)?.close();
    this.grpc.delete(handle.id);
    this.flutter.get(handle.id)?.close();
    this.flutter.delete(handle.id);
    const child = this.children.get(handle.id);
    if (
      (child &&
        child.pid === handle.processId &&
        child.exitCode === null &&
        !child.killed) ||
      (await this.ownsDevice(handle))
    )
      await this.adb(handle, ["emu", "kill"], 3000);
    if (child?.pid === handle.processId) child?.kill();
    this.children.delete(handle.id);
    if (handle.port) allocated.delete(handle.port);
  }
  async destroy(handle: DeviceHandle) {
    await this.shutdown(handle);
  }
  screen(handle: DeviceHandle) {
    const driver = this;
    const screenshot = async () => {
      const grpc = driver.grpc.get(handle.id);
      if (grpc) {
        try {
          return (await grpc.screenshot()).image;
        } catch {
          grpc.close();
          driver.grpc.delete(handle.id);
        }
      }
      return captureDeviceBytes(
        driver.host,
        androidTool(driver.sdkRoot(), "adb", driver.os),
        ["-s", handle.id, "exec-out", "screencap", "-p"],
      );
    };
    return {
      screenshot,
      async *frames(signal: AbortSignal) {
        const grpc = driver.grpc.get(handle.id);
        if (grpc) {
          try {
            for await (const frame of grpc.frames(signal)) {
              yield {
                data: frame.image,
                width: frame.format.width,
                height: frame.format.height,
                pointWidth: handle.pointWidth,
                pointHeight: handle.pointHeight,
              };
            }
          } catch {
            /* Fall back to adb. */
          }
          if (!signal.aborted) {
            grpc.close();
            driver.grpc.delete(handle.id);
          }
        }
        while (!signal.aborted) {
          yield {
            data: await screenshot(),
            width: handle.width,
            height: handle.height,
            pointWidth: handle.pointWidth,
            pointHeight: handle.pointHeight,
          };
          await new Promise((r) => setTimeout(r, 500));
        }
      },
    };
  }
  input(handle: DeviceHandle): DeviceInput {
    const scale = handle.width / handle.pointWidth,
      pixel = (n: number) => Math.round(n * scale),
      grpc = () => this.grpc.get(handle.id);
    const buttons: Record<string, { code: string; key: string }> = {
      home: { code: "3", key: "GoHome" },
      back: { code: "4", key: "GoBack" },
      "app-switch": { code: "187", key: "AppSwitch" },
      lock: { code: "26", key: "Power" },
      "volume-up": { code: "24", key: "AudioVolumeUp" },
      "volume-down": { code: "25", key: "AudioVolumeDown" },
    };
    return {
      tap: async (x, y) => {
        const c = grpc();
        if (c) await c.tap(pixel(x), pixel(y));
        else
          await this.shell(handle, [
            "input",
            "tap",
            String(pixel(x)),
            String(pixel(y)),
          ]);
      },
      swipe: async (x, y, tx, ty) => {
        const c = grpc();
        if (c) await c.swipe(pixel(x), pixel(y), pixel(tx), pixel(ty));
        else
          await this.shell(handle, [
            "input",
            "swipe",
            String(pixel(x)),
            String(pixel(y)),
            String(pixel(tx)),
            String(pixel(ty)),
            "250",
          ]);
      },
      type: async (text) => {
        const c = grpc();
        if (c) await c.type(text);
        else
          await this.shell(handle, ["input", "text", text.replace(/ /g, "%s")]);
      },
      key: async (key) => {
        const codes: Record<string, string> = {
          Enter: "66",
          Backspace: "67",
          Tab: "61",
          Escape: "111",
          ArrowUp: "19",
          ArrowDown: "20",
          ArrowLeft: "21",
          ArrowRight: "22",
        };
        if (!codes[key])
          throw new Error("This key is unavailable on the emulator.");
        const c = grpc();
        if (c) await c.key(key);
        else await this.shell(handle, ["input", "keyevent", codes[key]!]);
      },
      button: async (button) => {
        const value = buttons[button];
        if (!value)
          throw new Error("This button is unavailable on the emulator.");
        const c = grpc();
        if (c) await c.key(value.key);
        else await this.shell(handle, ["input", "keyevent", value.code]);
      },
      openUrl: async (url) => {
        await this.shell(handle, [
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          url,
        ]);
      },
      appearance: async (value) => {
        await this.shell(handle, [
          "cmd",
          "uimode",
          "night",
          value === "dark" ? "yes" : "no",
        ]);
      },
    };
  }
  async describeUi(handle: DeviceHandle) {
    const xml = await this.adbChecked(handle, [
      "exec-out",
      "uiautomator",
      "dump",
      "/dev/tty",
    ]);
    return androidUiNodes(xml, (handle.width / handle.pointWidth) * 160);
  }
  async *logs(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
    signal: AbortSignal,
  ) {
    const flutter = this.flutter.get(handle.id);
    if (flutter) {
      yield* flutter.logs(signal);
      return;
    }
    const pid = (
      await this.shell(handle, ["pidof", "-s", target.app.applicationId!])
    ).trim();
    if (!/^\d+$/.test(pid)) return;
    const child = this.host.spawn(
      androidTool(this.sdkRoot(), "adb", this.os),
      ["-s", handle.id, "logcat", `--pid=${pid}`, "-v", "brief"],
      { signal },
    );
    child.stderr.resume();
    yield* commandLines(child);
  }
  async ownedDevices() {
    if (!existsSync(androidTool(this.sdkRoot(), "adb", this.os))) return [];
    const devices = (
      await this.host.run(androidTool(this.sdkRoot(), "adb", this.os), [
        "devices",
      ])
    ).stdout;
    const result: DeviceHandle[] = [];
    for (const match of devices.matchAll(/^(emulator-\d+)\s+device$/gm)) {
      const id = match[1]!,
        handle: DeviceHandle = {
          id,
          platform: "android",
          name: "Blame · orphan",
          os: "",
          model: "",
          width: 0,
          height: 0,
          pointWidth: 360,
          pointHeight: 800,
        };
      if (await this.ownsDevice(handle)) result.push(handle);
    }
    return result;
  }
  private async ownsDevice(handle: DeviceHandle) {
    if (!/^emulator-\d+$/.test(handle.id)) return false;
    const result = await this.adb(handle, ["emu", "avd", "path"], 3000);
    const normalize = (path: string) =>
      path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const directory = normalize(join(this.root, "android-avds"));
    const path = normalize(result.stdout.split(/\r?\n/)[0]?.trim() ?? "");
    return (
      result.exitCode === 0 &&
      path.startsWith(directory + "/Blame_Phone_".toLowerCase()) &&
      path.endsWith(".avd")
    );
  }
  private adb(handle: DeviceHandle, args: string[], timeoutMs = 15000) {
    return this.host.run(
      androidTool(this.sdkRoot(), "adb", this.os),
      ["-s", handle.id, ...args],
      { environment: this.environment(), timeoutMs },
    );
  }
  private async adbChecked(
    handle: DeviceHandle,
    args: string[],
    timeoutMs = 15000,
  ) {
    const result = await this.adb(handle, args, timeoutMs);
    if (result.exitCode)
      throw new Error(
        result.stderr || result.stdout || "The emulator command failed.",
      );
    return result.stdout;
  }
  private shell(handle: DeviceHandle, args: string[]) {
    return this.adbChecked(handle, ["shell", args.map(quote).join(" ")]);
  }
}
export function quote(value: string) {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
async function freePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const selected =
        address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(selected));
    });
  });
}
const allocated = new Set<number>();
async function emulatorPort() {
  for (let port = 5554; port <= 5682; port += 2) {
    if (allocated.has(port)) continue;
    try {
      await freePort(port);
      await freePort(port + 1);
      allocated.add(port);
      return port;
    } catch {
      /* Try another console pair. */
    }
  }
  throw new Error(
    "No Android emulator port is available. Stop an unused emulator and try again.",
  );
}
async function findApks(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await findApks(file, depth + 1)));
    else if (entry.name.endsWith(".apk") && !entry.name.includes("androidTest"))
      result.push(file);
  }
  return result;
}
