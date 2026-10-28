import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { androidToolsRelease } from "./android-sdk.ts";
import { downloadDeviceTool } from "./device-tools.ts";
import { checked, type DeviceHost } from "./device-host.ts";

export async function installAndroidTools(
  dataRoot: string,
  host: DeviceHost,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
) {
  const release =
    platform === "win32"
      ? androidToolsRelease.win
      : platform === "darwin"
        ? arch === "arm64"
          ? androidToolsRelease.mac_arm64
          : androidToolsRelease.mac_x86_64
        : androidToolsRelease.linux;
  const root = join(dataRoot, "device-tools/android-sdk"),
    temporary = join(dataRoot, "device-tools/android-install"),
    archive = `${temporary}.zip`;
  await mkdir(join(root, "cmdline-tools"), { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await downloadDeviceTool(
      `https://dl.google.com/android/repository/${release.file}`,
      release.sha256,
      archive,
    );
    if (platform === "win32")
      await checked(host, "powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${temporary.replace(/'/g, "''")}'`,
      ]);
    else await checked(host, "unzip", ["-q", archive, "-d", temporary]);
    const names = await readdir(temporary);
    if (!names.includes("cmdline-tools"))
      throw new Error(
        "The Android SDK archive did not contain command-line tools.",
      );
    const destination = join(
      root,
      "cmdline-tools",
      androidToolsRelease.version,
    );
    await rm(destination, { force: true, recursive: true });
    await rename(join(temporary, "cmdline-tools"), destination);
    return root;
  } finally {
    await rm(archive, { force: true });
    await rm(temporary, { force: true, recursive: true });
  }
}
