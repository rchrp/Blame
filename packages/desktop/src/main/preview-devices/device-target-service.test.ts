import assert from "node:assert/strict";
import test from "node:test";
import { DeviceTargetService } from "./device-target-service.ts";
import type { DeviceDriver, DeviceStory } from "./types.ts";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";

test("device lifecycle deduplicates builds, limits booted devices and shuts idle ones down", async () => {
  let now = 0,
    builds = 0;
  const stopped: string[] = [],
    removed: string[] = [];
  const driver = {
    platform: "ios",
    availability: async () => ({ status: "ready" }),
    ensureDevice: async (story: DeviceStory) => ({
      id: story.id,
      platform: "ios",
      name: "Blame · " + story.id,
      os: "26",
      model: "iPhone",
      width: 0,
      height: 0,
      pointWidth: 390,
      pointHeight: 844,
    }),
    build: async () => {
      builds++;
      return { ok: true, artifact: "/app", durationMs: 1 };
    },
    install: async () => {},
    launch: async () => {},
    terminate: async () => {},
    shutdown: async (h: { id: string }) => {
      stopped.push(h.id);
    },
    destroy: async (h: { id: string }) => {
      removed.push(h.id);
    },
    async *logs() {},
  } as unknown as DeviceDriver;
  const service = new DeviceTargetService({
    drivers: [driver],
    mirror: async (s) => s.worktree,
    prepare: async () => {},
    services: async () => ({}),
    confirm: async () => true,
    persist: async () => {},
    removeMirror: async () => {},
    now: () => now,
    limit: 2,
  });
  const story = (id: string): DeviceStory => ({
    id,
    title: id,
    projectId: "project",
    worktree: "/" + id,
    buildRoot: "/" + id,
    workspaceMode: "local-container",
  });
  const target: PreviewManifestDeviceTarget = {
    id: "ios",
    platform: "ios",
    projectDir: ".",
    toolchain: "xcode",
    build: { workspace: "App.xcworkspace", scheme: "App" },
    app: { bundleId: "com.example.App" },
  };
  const first = service.start(story("one"), target);
  assert.equal(service.start(story("one"), target), first);
  assert.equal((await first).status, "ready");
  now = 1;
  await service.start(story("two"), target);
  now = 2;
  await service.start(story("three"), target);
  assert.equal(builds, 3);
  assert.ok(stopped.includes("one"));
  now = 21 * 60000;
  await service.shutdownIdle();
  assert.equal(service.status("three", false).status, "stopped");
  await service.stop("two", true);
  assert.ok(removed.includes("two"));
  const cloud = await service.availability(
    { ...story("cloud"), workspaceMode: "cloud-mirror" },
    target,
  );
  assert.deepEqual(cloud, { status: "unavailable", reason: "cloud_story" });
});

test("stop cancels an in-flight boot without installing or launching", async () => {
  const booting = Promise.withResolvers<void>();
  let installed = false;
  const driver = {
    platform: "ios",
    availability: async () => ({ status: "ready" }),
    ensureDevice: async (
      _story: unknown,
      _target: unknown,
      signal: AbortSignal,
    ) => {
      booting.resolve();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    build: async () => ({ ok: true, artifact: "/app", durationMs: 1 }),
    install: async () => {
      installed = true;
    },
    launch: async () => {
      throw new Error("Cancelled device must not launch");
    },
  } as unknown as DeviceDriver;
  const service = new DeviceTargetService({
    drivers: [driver],
    mirror: async (s) => s.worktree,
    prepare: async () => {},
    services: async () => ({}),
    confirm: async () => true,
    persist: async () => {},
    removeMirror: async () => {},
  });
  const start = service.start(
    {
      id: "s",
      projectId: "p",
      title: "s",
      worktree: "/s",
      buildRoot: "/s",
      workspaceMode: "local-container",
    },
    {
      id: "ios",
      platform: "ios",
      projectDir: ".",
      toolchain: "xcode",
      build: { project: "App.xcodeproj", scheme: "App" },
      app: { bundleId: "com.example.App" },
    },
  );
  await booting.promise;
  await service.stopAll();
  assert.equal((await start).status, "stopped");
  assert.equal(installed, false);
});

test("startup shuts restored devices down and destroys only unowned Blame devices", async () => {
  const stopped: string[] = [],
    destroyed: string[] = [];
  const handle = (id: string, name = "Blame · " + id) => ({
    id,
    name,
    platform: "ios" as const,
    os: "26",
    model: "iPhone",
    width: 0,
    height: 0,
    pointWidth: 390,
    pointHeight: 844,
  });
  const driver = {
    platform: "ios",
    ownedDevices: async () => [
      handle("kept"),
      handle("orphan"),
      handle("personal", "My iPhone"),
    ],
    shutdown: async (h: { id: string }) => {
      stopped.push(h.id);
    },
    destroy: async (h: { id: string }) => {
      destroyed.push(h.id);
    },
  } as unknown as DeviceDriver;
  const service = new DeviceTargetService({
    drivers: [driver],
    mirror: async (s) => s.worktree,
    prepare: async () => {},
    services: async () => ({}),
    confirm: async () => true,
    persist: async () => {},
    removeMirror: async () => {},
  });
  service.restore([
    {
      story: {
        id: "kept",
        projectId: "p",
        title: "Kept",
        worktree: "/s",
        buildRoot: "/s",
        workspaceMode: "local-container",
      },
      target: {
        id: "ios",
        platform: "ios",
        projectDir: ".",
        toolchain: "xcode",
        build: { project: "App.xcodeproj", scheme: "App" },
        app: { bundleId: "com.example.App" },
      },
      handle: handle("kept"),
    },
  ]);
  await service.cleanupOrphans(async () => true);
  assert.deepEqual(stopped, ["kept"]);
  assert.deepEqual(destroyed, ["orphan"]);
});
