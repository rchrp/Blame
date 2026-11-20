import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles, text } from "./env-files.mjs";
import { copyLimaBundle } from "./lima-runtime-bundle.mjs";
import { sha256File } from "./file-sha256.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(rootDir, "packages/desktop");
const runtimeRoot = join(desktopDir, "resources/runtime");
const windowsManifestPath = "windows/manifest.json";
const macosManifestPath = "macos/manifest.json";
const windowsArchitectures = ["amd64", "arm64"];
const macosArchitectures = ["x86_64", "aarch64"];

export async function prepareRuntimeManifests(
  targetRuntimeRoot = runtimeRoot,
  options = {},
) {
  const versionSource = JSON.parse(
    await readFile(join(targetRuntimeRoot, windowsManifestPath), "utf8"),
  );
  const publishedRuntime = await loadPublishedRuntimeManifest(
    runtimeVersionFor(versionSource),
    options,
  );
  const resolvedOptions = {
    ...options,
    publishedRuntime: publishedRuntime ?? options.publishedRuntime,
  };
  const windows = await prepareWindowsRuntimeManifest(
    targetRuntimeRoot,
    resolvedOptions,
  );
  const macos = await prepareMacosRuntimeManifest(
    targetRuntimeRoot,
    resolvedOptions,
  );
  return { windows, macos };
}

export async function prepareWindowsRuntimeManifest(
  targetRuntimeRoot = runtimeRoot,
  options = {},
) {
  const manifestPath = join(targetRuntimeRoot, windowsManifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimeVersion = runtimeVersionFor(manifest);
  manifest.runtimeVersion = runtimeVersion;
  manifest.rootfs = await windowsRootfsSpecs(manifest, runtimeVersion, options);
  assertRequiredWindowsRootfs(
    manifest.rootfs,
    options.requireWindowsPrebuiltArchitecture,
  );
  await writeJson(manifestPath, manifest);
  return manifest;
}

export async function prepareMacosRuntimeManifest(
  targetRuntimeRoot = runtimeRoot,
  options = {},
) {
  const manifestPath = join(targetRuntimeRoot, macosManifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimeVersion = runtimeVersionFor(manifest);
  manifest.runtimeVersion = runtimeVersion;
  manifest.images = await macosImageSpecs(manifest, runtimeVersion, options);
  assertRequiredMacosImage(
    manifest.images,
    options.requireMacosPrebuiltArchitecture,
  );
  await writeJson(manifestPath, manifest);
  await writeMacosTemplate(targetRuntimeRoot, manifest);
  await prepareMacosLimaBundle(
    targetRuntimeRoot,
    manifest,
    options.macosBundleArchitecture,
  );
  return manifest;
}

export function runtimeRootfsFileName(architecture, runtimeVersion) {
  return `blame-runtime-wsl-${architecture}-v${runtimeVersion}.tar.gz`;
}

export function runtimeLimaImageFileName(architecture, runtimeVersion) {
  return `blame-runtime-lima-${architecture}-v${runtimeVersion}.qcow2`;
}

export function rootfsPublicBaseUrl(runtimeVersion) {
  const explicitBaseUrl = text(process.env.BLAME_RUNTIME_ROOTFS_BASE_URL);
  if (explicitBaseUrl) return trimSlash(explicitBaseUrl);
  return runtimePlatformBaseUrl(runtimeVersion, "windows");
}

export function macosImagePublicBaseUrl(runtimeVersion) {
  const explicitBaseUrl = text(process.env.BLAME_RUNTIME_LIMA_BASE_URL);
  if (explicitBaseUrl) return trimSlash(explicitBaseUrl);
  return runtimePlatformBaseUrl(runtimeVersion, "macos");
}

async function windowsRootfsSpecs(manifest, runtimeVersion, options) {
  return Object.fromEntries(
    await Promise.all(
      windowsArchitectures.map(async (architecture) => [
        architecture,
        await windowsRootfsSpec(
          manifest,
          architecture,
          runtimeVersion,
          options,
        ),
      ]),
    ),
  );
}

async function windowsRootfsSpec(
  manifest,
  architecture,
  runtimeVersion,
  options,
) {
  const existing = manifest.rootfs?.[architecture] ?? {};
  const published =
    options.publishedRuntime?.artifacts?.windows?.[architecture];
  const fileName = runtimeRootfsFileName(architecture, runtimeVersion);
  const shaEnvironment = `BLAME_RUNTIME_ROOTFS_${envArch(architecture)}_SHA256`;
  const explicitSha256 = artifactEnvironmentSha256(shaEnvironment);
  const configuredSha256 =
    explicitSha256 ??
    (await artifactFileSha256(
      join(desktopDir, "dist/runtime/windows", fileName),
    ));
  const explicitUrl = text(
    process.env[`BLAME_RUNTIME_ROOTFS_${envArch(architecture)}_URL`],
  );
  const artifact = resolvePrebuiltArtifact(
    architecture,
    fileName,
    rootfsPublicBaseUrl(runtimeVersion),
    explicitUrl,
    explicitSha256,
    configuredSha256,
    published,
  );
  return artifact ? { kind: "blame-prebaked", ...artifact } : existing;
}

async function macosImageSpecs(manifest, runtimeVersion, options) {
  return Object.fromEntries(
    await Promise.all(
      macosArchitectures.map(async (architecture) => [
        architecture,
        await macosImageSpec(manifest, architecture, runtimeVersion, options),
      ]),
    ),
  );
}

async function macosImageSpec(manifest, architecture, runtimeVersion, options) {
  const published = options.publishedRuntime?.artifacts?.macos?.[architecture];
  const fileName = runtimeLimaImageFileName(architecture, runtimeVersion);
  const shaEnvironment = `BLAME_RUNTIME_LIMA_${envArch(architecture)}_SHA256`;
  const explicitSha256 = artifactEnvironmentSha256(shaEnvironment);
  const configuredSha256 =
    explicitSha256 ??
    (await artifactFileSha256(
      join(desktopDir, "dist/runtime/macos", fileName),
    ));
  const explicitUrl = text(
    process.env[`BLAME_RUNTIME_LIMA_${envArch(architecture)}_URL`],
  );
  const artifact = resolvePrebuiltArtifact(
    architecture,
    fileName,
    macosImagePublicBaseUrl(runtimeVersion),
    explicitUrl,
    explicitSha256,
    configuredSha256,
    published,
  );
  if (artifact) return { kind: "blame-prebaked", ...artifact };
  const baseImage = manifest.baseImages?.[architecture];
  if (!baseImage?.url || !baseImage?.sha256)
    throw new Error(`Missing macOS base image for ${architecture}.`);
  return { kind: "ubuntu", url: baseImage.url, sha256: baseImage.sha256 };
}

export async function loadPublishedRuntimeManifest(runtimeVersion, options) {
  if (
    !options.requireWindowsPrebuiltArchitecture &&
    !options.requireMacosPrebuiltArchitecture
  )
    return undefined;
  const url = runtimeManifestUrl(runtimeVersion);
  if (!url) throw new Error("Runtime manifest URL is not configured");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Runtime v${runtimeVersion} manifest returned HTTP ${response.status}`);
    const manifest = await response.json();
    if (String(manifest.runtimeVersion) !== runtimeVersion)
      throw new Error(`Published runtime version does not match v${runtimeVersion}`);
    return manifest;
  } catch (error) {
    throw new Error(`Unable to load runtime v${runtimeVersion} manifest: ${error.message}`, { cause: error });
  }
}

function runtimeManifestUrl(runtimeVersion) {
  const explicit = text(process.env.BLAME_RUNTIME_MANIFEST_URL);
  if (explicit) return explicit;
  const runtimeBaseUrl = text(process.env.BLAME_RUNTIME_BASE_URL);
  if (runtimeBaseUrl)
    return `${trimSlash(runtimeBaseUrl)}/v${runtimeVersion}/manifest.json`;
  const downloadBaseUrl = text(process.env.BLAME_DOWNLOAD_BASE_URL);
  if (!downloadBaseUrl) return undefined;
  return `${trimSlash(downloadBaseUrl.replace(/\/latest\/?$/, ""))}/runtime/v${runtimeVersion}/manifest.json`;
}

function assertRequiredWindowsRootfs(rootfs, architecture) {
  if (!architecture) return;
  const spec = rootfs[architecture];
  if (spec?.kind !== "blame-prebaked" || !spec.url || !isSha256(spec.sha256)) {
    throw new Error(
      `Missing verified prebaked Windows runtime for ${architecture}. Build it before packaging.`,
    );
  }
}

function assertRequiredMacosImage(images, architecture) {
  if (!architecture) return;
  const spec = images[architecture];
  if (spec?.kind !== "blame-prebaked" || !spec.url || !isSha256(spec.sha256)) {
    throw new Error(
      `Missing verified prebaked macOS runtime for ${architecture}. Build it before packaging.`,
    );
  }
}

function resolvePrebuiltArtifact(
  architecture,
  fileName,
  baseUrl,
  explicitUrl,
  explicitSha256,
  configuredSha256,
  published,
) {
  assertExplicitArtifactChecksum(explicitUrl, explicitSha256, architecture);
  if (explicitUrl) return { url: explicitUrl, sha256: explicitSha256 };
  const configuredUrl = derivedUrl(baseUrl, fileName, configuredSha256);
  if (configuredUrl) return { url: configuredUrl, sha256: configuredSha256 };
  if (!published?.url || !isSha256(published.sha256)) return undefined;
  return {
    url: published.url,
    sha256: published.sha256.toLowerCase(),
  };
}

function assertExplicitArtifactChecksum(url, explicitSha256, architecture) {
  if (url && !isSha256(explicitSha256)) {
    throw new Error(
      `Missing or invalid SHA-256 for configured ${architecture} runtime.`,
    );
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function writeMacosTemplate(targetRuntimeRoot, manifest) {
  const templatePath = join(targetRuntimeRoot, "macos/lima/blame-runtime.yaml");
  const lines = ["vmType: vz", "images:"];
  for (const architecture of ["aarch64", "x86_64"]) {
    const spec = manifest.images[architecture];
    lines.push(`  - location: ${JSON.stringify(spec.url)}`);
    lines.push(`    arch: ${architecture}`);
    lines.push(`    digest: ${JSON.stringify(`sha256:${spec.sha256}`)}`);
  }
  lines.push('disk: "80GiB"');
  lines.push("mounts:");
  lines.push('  - location: "~"');
  lines.push("    writable: true");
  lines.push("containerd:");
  lines.push("  system: false");
  lines.push("  user: false");
  lines.push("provision: []");
  lines.push("networks: []");
  await writeFile(templatePath, `${lines.join("\n")}\n`, "utf8");
}

async function prepareMacosLimaBundle(
  targetRuntimeRoot,
  manifest,
  architecture,
) {
  if (!architecture) return;
  await copyLimaBundle(
    manifest,
    "darwin",
    architecture === "aarch64" ? "arm64" : "x86_64",
    join(targetRuntimeRoot, "macos/lima/bundle"),
  );
}

function artifactEnvironmentSha256(environmentName) {
  return text(process.env[environmentName])?.toLowerCase();
}

async function artifactFileSha256(file) {
  try {
    return await sha256File(file);
  } catch {
    return undefined;
  }
}

function runtimePlatformBaseUrl(runtimeVersion, platform) {
  const runtimeBaseUrl = text(process.env.BLAME_RUNTIME_BASE_URL);
  if (runtimeBaseUrl)
    return `${trimSlash(runtimeBaseUrl)}/v${runtimeVersion}/${platform}`;
  const downloadBaseUrl = text(process.env.BLAME_DOWNLOAD_BASE_URL);
  if (!downloadBaseUrl) return undefined;
  const downloadRootUrl = downloadBaseUrl.replace(/\/latest\/?$/, "");
  return `${trimSlash(downloadRootUrl)}/runtime/v${runtimeVersion}/${platform}`;
}

function derivedUrl(baseUrl, fileName, enabled) {
  return enabled && baseUrl ? `${baseUrl}/${fileName}` : undefined;
}

function runtimeVersionFor(manifest) {
  return (
    text(process.env.BLAME_RUNTIME_VERSION) ?? String(manifest.runtimeVersion)
  );
}

function envArch(architecture) {
  return architecture.toUpperCase();
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadEnvFiles(rootDir);
  await prepareRuntimeManifests(
    process.argv[2] ? resolve(process.argv[2]) : runtimeRoot,
  );
}
