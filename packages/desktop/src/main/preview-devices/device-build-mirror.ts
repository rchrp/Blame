import { mkdir, realpath, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { DeviceStory } from "./types.ts";

export const deviceMirrorExcludes = [
  ".git",
  ".blame",
  "node_modules",
  "Pods",
  "build",
  ".dart_tool",
  ".gradle",
  "DerivedData",
  ".expo",
];
export function deviceMirrorArgs(source: string, destination: string) {
  return [
    "-a",
    "--delete",
    "--safe-links",
    ...deviceMirrorExcludes.flatMap((name) => ["--exclude", name]),
    "--",
    `${source.replace(/\/$/, "")}/`,
    `${destination.replace(/\/$/, "")}/`,
  ];
}
export function deviceMirrorPath(
  dataRoot: string,
  projectId: string,
  storyId: string,
) {
  if (![projectId, storyId].every((id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id)))
    throw new Error("Device preview identity is invalid.");
  return join(dataRoot, "device-builds", projectId, storyId);
}
export async function deviceProjectDirectory(
  story: DeviceStory,
  projectDir: string,
) {
  const root = await realpath(story.buildRoot),
    directory = await realpath(join(root, projectDir));
  const inside = relative(root, directory);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new Error(
      "The native project directory leaves this story's build folder.",
    );
  return directory;
}
export async function syncDeviceBuildMirror(
  story: DeviceStory,
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (story.workspaceMode === "direct" || platform === "linux")
    return story.worktree;
  const destination = deviceMirrorPath(dataRoot, story.projectId, story.id);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const { run } = await import("../workspace-runtime.ts");
  const guestDestination =
    platform === "win32"
      ? (
          await run("wslpath", ["-u", destination], { cwd: story.worktree })
        ).stdout.trim()
      : destination;
  await run("rsync", deviceMirrorArgs(story.worktree, guestDestination), {
    cwd: story.worktree,
    maxBuffer: 4 * 1024 * 1024,
  });
  return destination;
}
export async function removeDeviceMirror(
  dataRoot: string,
  projectId: string,
  storyId: string,
) {
  await rm(deviceMirrorPath(dataRoot, projectId, storyId), {
    recursive: true,
    force: true,
  });
}
