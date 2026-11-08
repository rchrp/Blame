import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { LightCommandCredentials } from "./light-contracts.js";

const execFileAsync = promisify(execFile);

/** The gh the managed runtimes and the sandbox image install (provision-blame-runtime.sh, sandbox-runner Dockerfile). */
export const githubCliVersion = "2.103.3";

// From gh_2.103.3_checksums.txt of the release.
const archiveChecksums: Partial<Record<string, string>> = {
  "linux_amd64.tar.gz": "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
  "linux_arm64.tar.gz": "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
  "macOS_amd64.zip": "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682",
  "macOS_arm64.zip": "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062",
  "windows_amd64.zip": "98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0",
  "windows_arm64.zip": "197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484",
};
const releaseSystems: Partial<Record<string, string>> = { darwin: "macOS", linux: "linux", win32: "windows" };
const releaseArchitectures: Partial<Record<string, string>> = { arm64: "arm64", x64: "amd64" };
const downloadTimeoutMs = 120_000;

export type GithubCliArchive = {
  url: string;
  sha256: string;
  /** Path of the gh executable inside the archive. */
  member: string;
};

/** The pinned gh release archive for this host, if gh publishes one. */
export function githubCliArchive(
  platform: string = process.platform,
  architecture: string = process.arch,
): GithubCliArchive | undefined {
  const system = releaseSystems[platform];
  const releaseArchitecture = releaseArchitectures[architecture];
  if (!system || !releaseArchitecture) return undefined;
  const extension = system === "linux" ? "tar.gz" : "zip";
  const sha256 = archiveChecksums[`${system}_${releaseArchitecture}.${extension}`];
  if (!sha256) return undefined;
  const stem = `gh_${githubCliVersion}_${system}_${releaseArchitecture}`;
  return {
    url: `https://github.com/cli/cli/releases/download/v${githubCliVersion}/${stem}.${extension}`,
    sha256,
    member: system === "windows" ? "bin/gh.exe" : `${stem}/bin/gh`,
  };
}

const installs = new Map<string, Promise<string>>();

/**
 * The directory holding gh under root, downloaded once and installed only
 * when the archive matches its pinned checksum. Concurrent commands share one
 * download; after a failure, the next command tries again.
 */
export function installGithubCli(root: string, archive: GithubCliArchive): Promise<string> {
  const directory = join(root, archive.sha256);
  let install = installs.get(directory);
  if (!install) {
    install = installedOrDownloaded(directory, archive);
    installs.set(directory, install);
    install.catch(() => installs.delete(directory));
  }
  return install;
}

async function installedOrDownloaded(directory: string, archive: GithubCliArchive) {
  const binDirectory = join(directory, "bin");
  const binary = join(binDirectory, basename(archive.member));
  if (await exists(binary)) return binDirectory;
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(`${directory}.download-`);
  try {
    const downloaded = join(staging, "archive");
    await writeFile(downloaded, await verifiedDownload(archive));
    const extracted = join(staging, "extracted");
    await mkdir(extracted);
    await execFileAsync(tarExecutable(), ["-xf", downloaded, "-C", extracted, archive.member]);
    const staged = join(staging, "gh");
    await mkdir(join(staged, "bin"), { recursive: true });
    await rename(join(extracted, archive.member), join(staged, "bin", basename(archive.member)));
    await chmod(join(staged, "bin", basename(archive.member)), 0o755);
    await rename(staged, directory).catch(async (error: unknown) => {
      // Another agent process installed the same archive first.
      if (!(await exists(binary))) throw error;
    });
    return binDirectory;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function verifiedDownload(archive: GithubCliArchive) {
  const response = await fetch(archive.url, { redirect: "follow", signal: AbortSignal.timeout(downloadTimeoutMs) });
  if (!response.ok) throw new Error(`Could not download ${archive.url}: HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== archive.sha256)
    throw new Error(`gh archive checksum mismatch for ${archive.url}: expected ${archive.sha256}, received ${actual}.`);
  return content;
}

// bsdtar reads the zip archives of macOS and Windows; GNU tar from PATH could not.
function tarExecutable() {
  if (process.platform === "darwin") return "/usr/bin/tar";
  if (process.platform === "win32") return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

let configDirectory: Promise<string> | undefined;

// Empty and owned by this process: gh never reads or writes the person's
// ~/.config/gh (their account, aliases, hosts) for the App token's commands.
function githubCliConfigDirectory() {
  configDirectory ??= mkdtemp(join(tmpdir(), "blame-gh-config-"));
  return configDirectory;
}

function githubCliRoot() {
  return process.env.BLAME_GITHUB_CLI_DIR?.trim() || join(tmpdir(), "blame-github-cli");
}

/**
 * Cloud commands run on the host, where gh may be missing: with a GitHub
 * token, they also get the gh Blame provides and a config directory of their
 * own. When gh cannot be installed, the command still gets its token and
 * config directory, and finds gh only if the host has one.
 */
export async function withGithubCli(
  credentials: LightCommandCredentials,
  options: { root?: string; archive?: GithubCliArchive } = {},
): Promise<LightCommandCredentials> {
  if (!credentials.githubToken) return credentials;
  const archive = options.archive ?? githubCliArchive();
  const binDirectory = archive
    ? await installGithubCli(options.root ?? githubCliRoot(), archive).catch((error: unknown) => {
        console.warn("[blame-agent]", `gh ${githubCliVersion} could not be installed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
    : undefined;
  return {
    ...credentials,
    githubCli: { configDirectory: await githubCliConfigDirectory(), ...(binDirectory ? { binDirectory } : {}) },
  };
}
