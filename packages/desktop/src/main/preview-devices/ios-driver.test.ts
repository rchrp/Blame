import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IosDriver } from "./ios-driver.ts";
import {
  chooseIosDevice,
  compactIosUi,
  iosBuildArguments,
} from "./ios-parsers.ts";
import { mapBuildPath, parseBuildErrors } from "./build-errors.ts";
import { deviceMirrorArgs, deviceMirrorPath } from "./device-build-mirror.ts";
import { mjpegFrames } from "./frame-stream.ts";
import type { DeviceHost } from "./device-host.ts";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";

const target: PreviewManifestDeviceTarget = {
  id: "ios",
  platform: "ios",
  projectDir: ".",
  toolchain: "xcode",
  build: { workspace: "App.xcworkspace", scheme: "App" },
  app: { bundleId: "com.example.App" },
};
const list = {
  runtimes: [
    {
      name: "iOS 26.0",
      identifier: "ios26",
      version: "26.0",
      isAvailable: true,
    },
  ],
  devicetypes: [
    { name: "iPhone 17 Pro Max", identifier: "pro" },
    { name: "iPhone 17", identifier: "normal" },
  ],
};
test("iOS commands choose a normal phone, build without signing and preserve literal arguments", () => {
  assert.equal(chooseIosDevice(list, target).model.identifier, "normal");
  const args = iosBuildArguments(
    target,
    "udid",
    "/mirror/Derived Data",
    "/result.xcresult",
  );
  assert.ok(args.includes("id=udid"));
  assert.ok(args.includes("CODE_SIGNING_ALLOWED=NO"));
  assert.ok(args.includes("/mirror/Derived Data"));
  assert.throws(
    () => iosBuildArguments({ ...target, build: {} }, "id", "/d", "/r"),
    /scheme/,
  );
});
test("iOS prerequisites follow Xcode selection and availability is neutral on other hosts", async () => {
  const host: DeviceHost = {
    run: async (command, args) => ({
      exitCode: 0,
      stdout:
        command === "xcode-select"
          ? "/Applications/Xcode.app/Contents/Developer"
          : command === "axe"
            ? "axe 1.8.0"
            : args.includes("runtimes")
              ? JSON.stringify(list)
              : "Xcode 26",
      stderr: "",
    }),
    spawn() {
      throw new Error("not used");
    },
  };
  assert.deepEqual(
    await new IosDriver({
      host,
      axe: "axe",
      cache: "/tmp/frames",
      platform: "linux",
    }).availability(),
    { status: "unavailable", reason: "not_macos" },
  );
  assert.deepEqual(
    await new IosDriver({
      host,
      axe: "axe",
      cache: "/tmp/frames",
      platform: "darwin",
    }).availability(),
    { status: "ready" },
  );
});
test("iOS boots headlessly and degrades controls when AXe cannot take a frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-ios-")),
    commands: string[][] = [];
  const host: DeviceHost = {
    async run(command, args) {
      commands.push([command, ...args]);
      return {
        exitCode: command === "axe" ? 1 : 0,
        stdout: args.includes("list")
          ? JSON.stringify({ ...list, devices: {} })
          : args.includes("create")
            ? "udid"
            : "",
        stderr: "",
      };
    },
    spawn() {
      throw new Error("not used");
    },
  };
  try {
    const driver = new IosDriver({
      host,
      axe: "axe",
      cache: root,
      platform: "darwin",
    });
    const handle = await driver.ensureDevice(
      {
        id: "story",
        projectId: "project",
        title: "A label",
        worktree: root,
        buildRoot: root,
        workspaceMode: "local-container",
      },
      target,
    );
    assert.equal(handle.id, "udid");
    assert.match(handle.limited!, /touches are unavailable/);
    assert.ok(commands.some((args) => args.includes("bootstatus")));
    assert.ok(commands.every((args) => !args.includes("Simulator.app")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("source mirrors protect host dependencies and map build errors to the worktree", () => {
  const args = deviceMirrorArgs("/vm/story", "/mirror/story");
  assert.ok(args.includes("--delete"));
  assert.ok(args.includes("--safe-links"));
  assert.ok(args.includes("Pods"));
  assert.ok(args.includes("node_modules"));
  assert.throws(() => deviceMirrorPath("/data", "../outside", "story"));
  assert.equal(
    mapBuildPath("file:///mirror/App.swift", "/mirror", "/vm/story"),
    "/vm/story/App.swift",
  );
  assert.equal(
    parseBuildErrors(
      "/mirror/App.swift:12:4: error: Unknown name",
      "/mirror",
      "/vm/story",
    )[0]!.file,
    "/vm/story/App.swift",
  );
});
test("accessibility trees and MJPEG frames are bounded and tolerate split chunks", async () => {
  assert.equal(
    compactIosUi(
      Array.from({ length: 500 }, () => ({
        AXRole: "Button",
        AXLabel: "Save",
        frame: { x: 1, y: 2, width: 3, height: 4 },
      })),
    ).length,
    400,
  );
  const frames = [];
  for await (const frame of mjpegFrames(
    (async function* () {
      yield Buffer.from([255, 216, 1]);
      yield Buffer.from([2, 255, 217, 255, 216, 3, 255, 217]);
    })(),
  ))
    frames.push([...frame]);
  assert.deepEqual(frames, [
    [255, 216, 1, 2, 255, 217],
    [255, 216, 3, 255, 217],
  ]);
});

test("xcresult diagnostics and Windows file URLs map to worktree files", async () => {
  const { parseXcodeBuildIssues } = await import("./build-errors.ts");
  assert.deepEqual(
    parseXcodeBuildIssues(
      {
        errors: [
          {
            issueType: "Swift Compiler Error",
            message: "Cannot find 'label' in scope",
            sourceURL:
              "file:///mirror/My%20App/ContentView.swift#StartingLineNumber=17&StartingColumnNumber=9",
          },
        ],
      },
      "/mirror",
      "/worktree",
    ),
    [
      {
        file: "/worktree/My App/ContentView.swift",
        line: 17,
        message: "Cannot find 'label' in scope",
      },
    ],
  );
  assert.equal(
    mapBuildPath(
      "file:///C:/Mirror/app/Main.kt",
      "C:\\Mirror\\app",
      "/worktree",
    ),
    "/worktree/Main.kt",
  );
});

test("a framework-incompatible AXe allows the simctl-only preview", async () => {
  const driver = new IosDriver({
    platform: "darwin",
    axe: "axe",
    cache: "/tmp/frames",
    host: {
      run: async (command, args) => ({
        exitCode: command === "axe" ? 134 : 0,
        stdout:
          command === "xcode-select"
            ? "/Applications/Xcode.app/Contents/Developer"
            : args.includes("runtimes")
              ? JSON.stringify(list)
              : "Xcode 27",
        stderr:
          command === "axe" ? "dyld: Library not loaded: SimulatorKit" : "",
      }),
      spawn() {
        throw new Error("not used");
      },
    },
  });
  assert.deepEqual(await driver.availability(target), { status: "ready" });
});
