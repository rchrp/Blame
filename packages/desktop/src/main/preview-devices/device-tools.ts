import { axeNotices } from "./device-tool-notices.ts";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { checked, type DeviceHost } from "./device-host.ts";

export const axeRelease = {
  version: "1.8.0",
  url: "https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-homebrew-v1.8.0.tar.gz",
  sha256: "87eb09cd49dfc74fa8f7f5a46a03dfe2f14518b01d819f6a4094eab0d344ea7f",
} as const;
export function verifiedToolBytes(data: Buffer, sha256: string) {
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw new Error(
      "The downloaded tool failed its integrity check. Try downloading it again.",
    );
  return data;
}
export async function downloadDeviceTool(
  url: string,
  sha256: string,
  destination: string,
) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok)
    throw new Error(
      "The device tools could not be downloaded. Check your connection and try again.",
    );
  if (Number(response.headers.get("content-length")) > 512 * 1024 * 1024)
    throw new Error("The tool archive is too large.");
  const data = verifiedToolBytes(
    Buffer.from(await response.arrayBuffer()),
    sha256,
  );
  await writeFile(destination, data, { mode: 0o600 });
}
export async function installAxe(dataRoot: string, host: DeviceHost) {
  const root = join(dataRoot, "device-tools");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = join(root, `axe-${axeRelease.version}`),
    temporary = `${destination}.installing`,
    archive = `${temporary}.tar.gz`;
  await rm(temporary, { force: true, recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    await downloadDeviceTool(axeRelease.url, axeRelease.sha256, archive);
    const files = await checked(host, "tar", ["-tzf", archive]);
    if (
      files
        .split("\n")
        .some((p) => p.startsWith("/") || p.split("/").includes(".."))
    )
      throw new Error("The device tool archive contains an invalid path.");
    await checked(host, "tar", ["-xzf", archive, "-C", temporary]);
    // Match the upstream Homebrew installer: packaged private frameworks need
    // ad-hoc signatures after extraction. This requires no elevated privileges.
    for (const file of await readdir(join(temporary, "Frameworks")))
      if (file.endsWith(".framework"))
        await checked(host, "codesign", [
          "--force",
          "--sign",
          "-",
          "--timestamp=none",
          join(temporary, "Frameworks", file),
        ]);
    await checked(host, "codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      join(temporary, "axe"),
    ]);
    await writeFile(join(temporary, "THIRD_PARTY_NOTICES.txt"), axeNotices);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return join(destination, "axe");
  } finally {
    await rm(archive, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}
