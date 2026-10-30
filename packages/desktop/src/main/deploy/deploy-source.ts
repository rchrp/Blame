import {
  deriveDeploymentManifest,
  parseDeploymentManifest,
  type DeploymentDiagnostic,
  type DeploymentManifest,
  type DeploymentSnapshot,
} from "@blame/deploy-contract";
import type { PreviewManifest } from "@blame/preview-contract";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { hostGitCommand } from "../host-git.ts";
import { createGzip } from "node:zlib";
import ignore from "ignore";
import { pack } from "tar-stream";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);
const maximumFiles = 15_000;
const maximumSourceBytes = 100 * 1024 * 1024;
const deterministicTimestamp = new Date(0);

export type DeployPreflightInput = {
  root: string;
  previewManifest: PreviewManifest;
  runConfigurations: Array<{
    id: string;
    command: string;
    cwd: string;
    default: boolean;
    category: "web" | "mobile" | "desktop" | "terminal" | "service" | "other";
    services: string[];
    previewService?: string | null;
    scopes: string[];
  }>;
};

export type DeployPreflight = {
  manifest: DeploymentManifest;
  snapshot: DeploymentSnapshot;
  excludedFileCount: number;
};

export type BuiltDeploySource = DeployPreflight & {
  content: Buffer;
  archiveSha256: string;
  archiveBytes: number;
};

type SourceFile = {
  absolutePath: string;
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

type SourceInventory = {
  files: SourceFile[];
  snapshot: Omit<DeploymentSnapshot, "workspaceHash" | "manifestHash">;
  excludedFileCount: number;
  blockers: DeploymentDiagnostic[];
};

export async function preflightDeploySource(
  input: DeployPreflightInput,
): Promise<DeployPreflight> {
  const root = await workspaceRoot(input.root);
  const derived = deriveDeploymentManifest(input);
  const configured = await refineManifestFromRepository(root, derived);
  const inventory = await sourceInventory(root, configured);
  const manifest = withSourceBlockers(configured, inventory.blockers);
  return {
    manifest,
    snapshot: snapshotForManifest(inventory, manifest),
    excludedFileCount: inventory.excludedFileCount,
  };
}

export async function buildDeploySource(
  input: DeployPreflightInput,
  expectedWorkspaceHash: string,
): Promise<BuiltDeploySource> {
  const root = await workspaceRoot(input.root);
  const derived = deriveDeploymentManifest(input);
  const configured = await refineManifestFromRepository(root, derived);
  const inventory = await sourceInventory(root, configured);
  const manifest = withSourceBlockers(configured, inventory.blockers);
  const snapshot = snapshotForManifest(inventory, manifest);
  if (manifest.compatibility.status === "unsupported") {
    throw new Error("This workspace is not compatible with Vercel deployment");
  }
  if (snapshot.workspaceHash !== expectedWorkspaceHash) {
    throw new Error("DEPLOY_WORKSPACE_CHANGED");
  }
  const archive = pack();
  const gzip = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gzip.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const writing = pipeline(archive, gzip);
  try {
    for (const file of inventory.files) {
      const content = await readFile(file.absolutePath);
      if (content.byteLength !== file.size || sha256(content) !== file.sha256) {
        throw new Error("DEPLOY_WORKSPACE_CHANGED");
      }
      archive.entry(
        {
          name: file.path,
          mode: file.mode,
          size: file.size,
          mtime: deterministicTimestamp,
          type: "file",
        },
        content,
      );
    }
    archive.finalize();
    await writing;
  } catch (error) {
    archive.destroy(error as Error);
    await writing.catch(() => undefined);
    throw error;
  }
  const verified = await sourceInventory(root, configured);
  const verifiedManifest = withSourceBlockers(configured, verified.blockers);
  if (
    snapshotForManifest(verified, verifiedManifest).workspaceHash !==
    expectedWorkspaceHash
  ) {
    throw new Error("DEPLOY_WORKSPACE_CHANGED");
  }
  const content = Buffer.concat(chunks);
  if (!content.byteLength || content.byteLength > maximumSourceBytes) {
    throw new Error("DEPLOY_SOURCE_TOO_LARGE");
  }
  return {
    content,
    archiveSha256: sha256(content),
    archiveBytes: content.byteLength,
    manifest,
    snapshot,
    excludedFileCount: inventory.excludedFileCount,
  };
}

async function sourceInventory(
  root: string,
  manifest: DeploymentManifest,
): Promise<SourceInventory> {
  const candidates = await gitFiles(root);
  const vercelIgnore = await vercelIgnoreMatcher(root, manifest.rootDirectory);
  const allowed = candidates.filter((path) => !hardExcluded(path));
  const selected = allowed.filter((path) => !vercelIgnore?.ignores(path));
  const blockers: DeploymentDiagnostic[] = [];
  const files: SourceFile[] = [];
  const caseInsensitivePaths = new Set<string>();
  let sourceBytes = 0;
  let secretDetected = false;
  let caseCollisionDetected = false;
  for (const path of selected.sort()) {
    const absolutePath = resolve(root, path);
    assertInside(root, absolutePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      blockers.push({
        code: "DEPLOY_SYMLINK_UNSUPPORTED",
        message:
          "The deployment source contains a symbolic link, which is not supported yet.",
        action:
          "Replace the link with files inside the project before deploying.",
      });
      continue;
    }
    if (!stat.isFile()) continue;
    const collisionKey = portablePath(path).toLocaleLowerCase("en-US");
    if (caseInsensitivePaths.has(collisionKey)) caseCollisionDetected = true;
    caseInsensitivePaths.add(collisionKey);
    const content = await readFile(absolutePath);
    sourceBytes += content.byteLength;
    if (!secretDetected && content.byteLength <= 1024 * 1024) {
      secretDetected = highConfidenceSecret(content);
    }
    files.push({
      absolutePath,
      path: portablePath(path),
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
      size: content.byteLength,
      sha256: sha256(content),
    });
  }
  if (files.length > maximumFiles || sourceBytes > maximumSourceBytes) {
    blockers.push({
      code: "DEPLOY_SOURCE_TOO_LARGE",
      message: `The deployment source exceeds the ${maximumFiles.toLocaleString("en-US")} file or 100 MB conservative limit.`,
      action: "Exclude generated or unused files with .vercelignore.",
    });
  }
  if (secretDetected) {
    blockers.push({
      code: "DEPLOY_SECRET_DETECTED",
      message:
        "A high-confidence secret was detected in the deployment source.",
      action: "Remove the credential and rotate it before deploying.",
    });
  }
  if (caseCollisionDetected) {
    blockers.push({
      code: "DEPLOY_CASE_COLLISION",
      message:
        "The deployment source contains paths that differ only by letter case.",
      action: "Rename one of the conflicting files before deploying.",
    });
  }
  if (!files.length) {
    blockers.push({
      code: "DEPLOY_SOURCE_EMPTY",
      message: "No deployable source files were found.",
      action: "Check the project root and .vercelignore rules.",
    });
  }
  const [sourceRevision, branch, localChangeCount] = await Promise.all([
    gitOr(root, ["rev-parse", "--verify", "HEAD"], "unborn"),
    gitOr(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], ""),
    gitStatusCount(root),
  ]);
  return {
    files,
    excludedFileCount: candidates.length - files.length,
    blockers: uniqueDiagnostics(blockers),
    snapshot: {
      sourceRevision,
      sourceBranch: branch || null,
      detached: !branch,
      localChangeCount,
      fileCount: files.length,
      sourceBytes,
    },
  };
}

function snapshotForManifest(
  inventory: SourceInventory,
  manifest: DeploymentManifest,
): DeploymentSnapshot {
  const manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
  return {
    ...inventory.snapshot,
    manifestHash,
    workspaceHash: hashInventory(inventory.files, manifestHash),
  };
}

async function refineManifestFromRepository(
  root: string,
  manifest: DeploymentManifest,
) {
  const projectRoot = resolve(root, manifest.rootDirectory);
  assertInside(root, projectRoot);
  let repository: Awaited<ReturnType<typeof repositoryBuildSettings>>;
  try {
    repository = await repositoryBuildSettings(projectRoot);
  } catch {
    return parseDeploymentManifest({
      ...manifest,
      compatibility: {
        status: "unsupported",
        blockers: uniqueDiagnostics([
          ...manifest.compatibility.blockers,
          {
            code: "DEPLOY_CONFIG_INVALID",
            message: "vercel.json is invalid or too large to validate safely.",
            action: "Correct vercel.json before deploying.",
          },
        ]),
        warnings: manifest.compatibility.warnings,
      },
    });
  }
  const vercelTs = await fileExists(join(projectRoot, "vercel.ts"));
  const framework =
    repository.framework !== undefined
      ? repository.framework
      : vercelTs
        ? null
        : (manifest.framework ?? (await detectedFramework(projectRoot)));
  const warnings: DeploymentDiagnostic[] = [
    ...manifest.compatibility.warnings,
    ...(repository.framework !== undefined &&
    repository.framework !== manifest.framework
      ? [
          {
            code: "DEPLOY_REPOSITORY_CONFIG_PREVAILS",
            message:
              "The framework from vercel.json takes precedence over project detection.",
            action: "Review vercel.json before deploying to production.",
          },
        ]
      : []),
    ...(vercelTs
      ? [
          {
            code: "DEPLOY_PROGRAMMABLE_CONFIG",
            message: "This project uses programmable vercel.ts configuration.",
            action: "Review the configuration before deploying to production.",
          },
        ]
      : []),
  ];
  const candidate = {
    ...manifest,
    framework,
    ...repository,
    compatibility: {
      ...manifest.compatibility,
      status:
        manifest.compatibility.status === "supported" && warnings.length
          ? "conditional"
          : manifest.compatibility.status,
      warnings: uniqueDiagnostics(warnings),
    },
  };
  try {
    return parseDeploymentManifest(candidate);
  } catch {
    return parseDeploymentManifest({
      ...manifest,
      compatibility: {
        status: "unsupported",
        blockers: uniqueDiagnostics([
          ...manifest.compatibility.blockers,
          {
            code: "DEPLOY_CONFIG_INVALID",
            message:
              "vercel.json contains an unsupported production build setting.",
            action: "Correct vercel.json before deploying.",
          },
        ]),
        warnings: manifest.compatibility.warnings,
      },
    });
  }
}

async function repositoryBuildSettings(projectRoot: string): Promise<{
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
}> {
  try {
    const raw = await readFile(join(projectRoot, "vercel.json"), "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024)
      throw new Error("vercel.json is too large");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("vercel.json is invalid");
    }
    return {
      ...(typeof value.framework === "string" || value.framework === null
        ? { framework: value.framework }
        : {}),
      ...(typeof value.installCommand === "string"
        ? { installCommand: value.installCommand }
        : {}),
      ...(typeof value.buildCommand === "string"
        ? { buildCommand: value.buildCommand }
        : {}),
      ...(typeof value.outputDirectory === "string"
        ? { outputDirectory: value.outputDirectory }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function withSourceBlockers(
  manifest: DeploymentManifest,
  sourceBlockers: DeploymentDiagnostic[],
) {
  const blockers = uniqueDiagnostics([
    ...manifest.compatibility.blockers,
    ...sourceBlockers,
  ]);
  return parseDeploymentManifest({
    ...manifest,
    compatibility: {
      status: blockers.length ? "unsupported" : manifest.compatibility.status,
      blockers,
      warnings: manifest.compatibility.warnings,
    },
  });
}

async function detectedFramework(projectRoot: string) {
  try {
    const value = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = new Set([
      ...Object.keys(value.dependencies ?? {}),
      ...Object.keys(value.devDependencies ?? {}),
    ]);
    for (const [dependency, framework] of [
      ["next", "nextjs"],
      ["@sveltejs/kit", "sveltekit"],
      ["nuxt", "nuxtjs"],
      ["@remix-run/react", "remix"],
      ["astro", "astro"],
      ["gatsby", "gatsby"],
      ["@angular/core", "angular"],
      ["vite", "vite"],
    ] as const) {
      if (names.has(dependency)) return framework;
    }
  } catch {}
  return null;
}

async function vercelIgnoreMatcher(root: string, rootDirectory: string) {
  for (const location of [
    join(root, rootDirectory, ".vercelignore"),
    join(root, ".vercelignore"),
  ]) {
    try {
      const rules = await readFile(location, "utf8");
      const base = relative(root, resolve(location, ".."));
      const matcher = ignore().add(rules);
      return {
        ignores(path: string) {
          const scoped = base && base !== "." ? relative(base, path) : path;
          return (
            !scoped.startsWith("..") && matcher.ignores(portablePath(scoped))
          );
        },
      };
    } catch {}
  }
  return undefined;
}

async function gitFiles(root: string) {
  const output = await git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return Array.from(
    new Set(output.split("\0").filter(Boolean).map(portablePath)),
  );
}

async function gitStatusCount(root: string) {
  const output = await git(root, ["status", "--porcelain=v1", "-z"]);
  return output
    .split("\0")
    .filter((entry) => entry.length >= 4 && entry[2] === " ").length;
}

function hardExcluded(path: string) {
  const normalized = portablePath(path).toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.some((segment) =>
      [
        ".git",
        ".ssh",
        ".blame",
        ".vercel",
        "node_modules",
        ".pnpm-store",
        ".yarn",
        ".turbo",
        ".cache",
      ].includes(segment),
    )
  ) {
    return true;
  }
  if (
    basename === ".env" ||
    (basename.startsWith(".env.") &&
      !/\.(?:example|sample|template)$/.test(basename))
  ) {
    return true;
  }
  if (
    [
      ".npmrc",
      ".pypirc",
      "id_rsa",
      "id_ed25519",
      "credentials",
      "credentials.json",
      "service-account.json",
    ].includes(basename) ||
    /(?:^|\.)private[-_.]?key(?:\.|$)/.test(basename) ||
    /\.(?:pem|p12|pfx|key)$/.test(basename)
  ) {
    return true;
  }
  return /\.(?:log|sock)$/.test(basename);
}

function highConfidenceSecret(content: Buffer) {
  if (content.includes(0)) return false;
  const text = content.toString("utf8");
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
    /\bsk_live_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  ].some((pattern) => pattern.test(text));
}

function hashInventory(files: SourceFile[], manifestHash: string) {
  const hash = createHash("sha256");
  hash.update(`manifest\0${manifestHash}\0`);
  for (const file of files) {
    hash.update(`${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
}

async function workspaceRoot(value: string) {
  if (!isAbsolute(value))
    throw new Error("Deployment workspace must be absolute");
  return realpath(value);
}

function assertInside(root: string, path: string) {
  const child = relative(root, path);
  if (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  ) {
    return;
  }
  throw new Error("Deployment path escapes the workspace");
}

async function fileExists(path: string) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function portablePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function git(root: string, args: string[]) {
  const { stdout } = await execFileAsync(
    hostGitCommand(),
    ["-C", root, ...args],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return stdout.trimEnd();
}

async function gitOr(root: string, args: string[], fallback: string) {
  try {
    return await git(root, args);
  } catch {
    return fallback;
  }
}

function uniqueDiagnostics(diagnostics: DeploymentDiagnostic[]) {
  return diagnostics.filter(
    ({ code }, index) =>
      diagnostics.findIndex((item) => item.code === code) === index,
  );
}
