import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// The stable channel follows the update feed built into the app, which serves
// the latest published release. The beta channel follows the newest release on
// GitHub, prereleases included, and returns to stable releases once a newer
// one ships. Prereleases are public, so no token is needed.
export type DesktopUpdateChannel = "stable" | "beta";

export const releasesRepository = "rchrp/Blame";

type GitHubRelease = {
  assets?: { name: string }[];
  draft: boolean;
  tag_name: string;
};

type Fetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>;

const releaseTag = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return value === "stable" || value === "beta";
}

export async function readUpdateChannel(
  file: string,
): Promise<DesktopUpdateChannel> {
  try {
    const { channel } = JSON.parse(await readFile(file, "utf8"));
    return isUpdateChannel(channel) ? channel : "stable";
  } catch {
    return "stable";
  }
}

export async function writeUpdateChannel(
  file: string,
  channel: DesktopUpdateChannel,
) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ channel })}\n`, "utf8");
}

/** The update metadata electron-builder publishes for this platform. */
export function updateMetadataFile(platform: string, arch: string) {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
}

/**
 * Download folder of the newest published release that has update metadata
 * for this platform, or undefined when there is none.
 */
export async function betaFeedUrl(
  fetchReleases: Fetch,
  metadataFile: string,
  repository = releasesRepository,
) {
  const response = await fetchReleases(
    `https://api.github.com/repos/${repository}/releases?per_page=30`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub releases are unavailable (HTTP ${response.status}).`,
    );
  const release = newestRelease(
    (await response.json()) as GitHubRelease[],
    metadataFile,
  );
  return release
    ? `https://github.com/${repository}/releases/download/${release.tag_name}`
    : undefined;
}

export function newestRelease(releases: GitHubRelease[], metadataFile: string) {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        releaseTag.test(release.tag_name) &&
        release.assets?.some((asset) => asset.name === metadataFile),
    )
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name))[0];
}

/** Semantic version order of two `v<semver>` tags. */
export function compareVersions(left: string, right: string) {
  const a = releaseTag.exec(left);
  const b = releaseTag.exec(right);
  if (!a || !b) throw new Error(`Not a release tag: ${a ? right : left}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  return comparePrerelease(a[4], b[4]);
}

function comparePrerelease(left?: string, right?: string) {
  if (left === right) return 0;
  // A release ranks above its prereleases.
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const difference = compareIdentifier(a[index]!, b[index]!);
    if (difference) return difference;
  }
  return 0;
}

function compareIdentifier(left: string, right: string) {
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right))
    return Math.sign(Number(left) - Number(right));
  if (numeric.test(left)) return -1;
  if (numeric.test(right)) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
