import { basename } from "node:path";
import { publishedPreviewImages } from "@blame/preview-runtime/images";
import {
  scanProjectCloudTransfer,
  type ProjectCloudTransferScan,
} from "./project-cloud-transfer-scan.js";

import {
  discoverProjectFiles,
  isDatabaseEvidencePath,
  isMigrationEvidencePath,
  isProjectDocumentationPath,
  isProjectEntrypointPath,
  isProjectLockFilePath,
  isProjectManifestPath,
  isRuntimeEvidencePath,
  isSourceCodePath,
  isTestCodePath,
  preferNonGeneratedProjectPaths,
  selectBalancedProjectPaths,
  topLevelProjectEntries,
  type ProjectFileDiscovery,
  type ProjectRootEvidence,
} from "./project-discovery.js";
import { referencedScriptFiles } from "./project-host-orchestration.js";
import {
  balancedGitMessages,
  readBoundedProjectFiles,
  recentProjectGitLogs,
} from "./project-evidence-reader.js";

type InitializationCandidates = {
  manifestPaths: string[];
  runtimePaths: string[];
  entrypointPaths: string[];
  documentationPaths: string[];
  sourcePaths: string[];
  databaseConfigurationPaths: string[];
};

export type ProjectInitializationScan = {
  rootName: string;
  topLevelEntries: string[];
  files: Record<string, string>;
  gitLog: string[];
  cloudTransfer?: ProjectCloudTransferScan;
  /** Pinned images with the GUI libraries Linux screen previews need. */
  previewImages?: { electron?: string; tauri?: string };
  discovery?: {
    scannedFileCount: number;
    scannedDirectoryCount: number;
    ignoredDirectoryCount: number;
    truncated: boolean;
    projectRoots: ProjectRootEvidence[];
    repositoryRoots: string[];
    manifestFileCount: number;
    manifestPaths: string[];
    lockFileCount: number;
    lockFilePaths: string[];
    runtimeEvidenceFileCount: number;
    runtimeEvidencePaths: string[];
    entrypointFileCount: number;
    entrypointPaths: string[];
    databaseFileCount: number;
    databasePaths: string[];
    migrationFileCount: number;
    migrationPaths: string[];
  };
};

export type ProjectScanRootProvider = (
  workspace: string,
) => Promise<{ root: string; release(): Promise<void> }>;

/**
 * Scans a workspace this process may not read directly, such as a story
 * worktree inside the local runtime VM, through a readable copy.
 */
export async function scanProjectWorkspace(
  workspace: string,
  scanRoot?: ProjectScanRootProvider,
) {
  if (!scanRoot) return scanProjectForInitialization(workspace);
  const readable = await scanRoot(workspace);
  try {
    return await scanProjectForInitialization(readable.root);
  } finally {
    await readable.release();
  }
}

export async function scanProjectForInitialization(
  root: string,
): Promise<ProjectInitializationScan> {
  const discovery = await discoverProjectFiles(root);
  const candidates = initializationCandidates(discovery);
  const [evidence, gitLog, cloudTransfer] = await Promise.all([
    initializationEvidence(root, candidates),
    initializationGitLog(root, discovery.repositoryRoots),
    scanProjectCloudTransfer(root, discovery.files),
  ]);
  const files = await withPackageScriptFiles(root, discovery, evidence);
  return {
    rootName: basename(root),
    topLevelEntries: topLevelProjectEntries(discovery),
    files,
    gitLog,
    cloudTransfer,
    previewImages: {
      electron: publishedPreviewImages.node,
      tauri: publishedPreviewImages.tauri,
    },
    discovery: initializationDiscovery(discovery),
  };
}

function initializationCandidates(
  discovery: ProjectFileDiscovery,
): InitializationCandidates {
  const { files, projectRoots } = discovery;
  const entrypointPaths = balanced(
    files,
    projectRoots,
    isProjectEntrypointPath,
    16,
  );
  return {
    manifestPaths: balanced(files, projectRoots, isProjectManifestPath, 32),
    runtimePaths: balanced(files, projectRoots, isRuntimeEvidencePath, 24),
    entrypointPaths,
    documentationPaths: balanced(
      files,
      projectRoots,
      isProjectDocumentationPath,
      4,
    ),
    sourcePaths: initializationSourcePaths(discovery, entrypointPaths),
    databaseConfigurationPaths: databaseConfigurationPaths(discovery),
  };
}

function balanced(
  files: string[],
  roots: ProjectRootEvidence[],
  predicate: (path: string) => boolean,
  limit: number,
) {
  const matchingPaths = files.filter(predicate);
  const preferredPaths = preferNonGeneratedProjectPaths(matchingPaths, roots);
  return selectBalancedProjectPaths(preferredPaths, roots, limit);
}

function initializationSourcePaths(
  discovery: ProjectFileDiscovery,
  entrypointPaths: string[],
) {
  const entrypoints = new Set(entrypointPaths);
  const paths = discovery.files.filter(
    (path) =>
      isSourceCodePath(path) && !isTestCodePath(path) && !entrypoints.has(path),
  );
  const preferredPaths = preferNonGeneratedProjectPaths(
    paths,
    discovery.projectRoots,
  );
  return selectBalancedProjectPaths(preferredPaths, discovery.projectRoots, 10);
}

function databaseConfigurationPaths(discovery: ProjectFileDiscovery) {
  const paths = discovery.files.filter(
    (path) =>
      isDatabaseEvidencePath(path) && isReadableDatabaseConfiguration(path),
  );
  const preferredPaths = preferNonGeneratedProjectPaths(
    paths,
    discovery.projectRoots,
  );
  return selectBalancedProjectPaths(preferredPaths, discovery.projectRoots, 6);
}

function isReadableDatabaseConfiguration(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    name === "alembic.ini" ||
    name === "schema.prisma" ||
    /^(drizzle|prisma)\.config\.[a-z0-9]+$/.test(name)
  );
}

async function initializationEvidence(
  root: string,
  candidates: InitializationCandidates,
) {
  const evidence = await Promise.all([
    readBoundedProjectFiles(root, candidates.manifestPaths, 30_000, 5_000),
    readBoundedProjectFiles(root, candidates.runtimePaths, 14_000, 3_000),
    readBoundedProjectFiles(root, candidates.entrypointPaths, 8_000, 2_000),
    readBoundedProjectFiles(root, candidates.documentationPaths, 3_000, 2_000),
    readBoundedProjectFiles(root, candidates.sourcePaths, 8_000, 2_000),
    readBoundedProjectFiles(
      root,
      candidates.databaseConfigurationPaths,
      3_000,
      1_500,
    ),
  ]);
  return Object.assign({}, ...evidence) as Record<string, string>;
}

// Package scripts often delegate to local files (`node scripts/dev.mjs`).
// Their content decides whether a script can run inside a preview container.
async function withPackageScriptFiles(
  root: string,
  discovery: ProjectFileDiscovery,
  evidence: Record<string, string>,
) {
  const discovered = new Set(discovery.files);
  const paths = referencedScriptFiles(evidence)
    .filter((path) => discovered.has(path))
    .slice(0, 8);
  if (!paths.length) return evidence;
  return {
    ...evidence,
    ...(await readBoundedProjectFiles(root, paths, 24_000, 6_000)),
  };
}

async function initializationGitLog(root: string, repositories: string[]) {
  const logs = await recentProjectGitLogs(root, repositories, 12);
  return balancedGitMessages(logs, 12);
}

function initializationDiscovery(discovery: ProjectFileDiscovery) {
  return {
    scannedFileCount: discovery.files.length,
    scannedDirectoryCount: discovery.scannedDirectoryCount,
    ignoredDirectoryCount: discovery.ignoredDirectoryCount,
    truncated: discovery.truncated,
    projectRoots: discovery.projectRoots.slice(0, 120),
    repositoryRoots: discovery.repositoryRoots.slice(0, 60),
    ...initializationDiscoveryPaths(discovery),
  };
}

function initializationDiscoveryPaths(discovery: ProjectFileDiscovery) {
  const summarize = (predicate: (path: string) => boolean, limit: number) =>
    discoveryPathSummary(discovery, predicate, limit);
  const manifests = summarize(isProjectManifestPath, 120);
  const locks = summarize(isProjectLockFilePath, 120);
  const runtime = summarize(isRuntimeEvidencePath, 120);
  const entrypoints = summarize(isProjectEntrypointPath, 120);
  const database = summarize(isNonMigrationDatabasePath, 80);
  const migrations = summarize(isMigrationEvidencePath, 80);
  return {
    manifestFileCount: manifests.count,
    manifestPaths: manifests.paths,
    lockFileCount: locks.count,
    lockFilePaths: locks.paths,
    runtimeEvidenceFileCount: runtime.count,
    runtimeEvidencePaths: runtime.paths,
    entrypointFileCount: entrypoints.count,
    entrypointPaths: entrypoints.paths,
    databaseFileCount: database.count,
    databasePaths: database.paths,
    migrationFileCount: migrations.count,
    migrationPaths: migrations.paths,
  };
}

function discoveryPathSummary(
  discovery: ProjectFileDiscovery,
  predicate: (path: string) => boolean,
  limit: number,
) {
  const paths = matchingPaths(discovery, predicate);
  return {
    count: paths.length,
    paths: selectBalancedProjectPaths(paths, discovery.projectRoots, limit),
  };
}

function matchingPaths(
  discovery: ProjectFileDiscovery,
  predicate: (path: string) => boolean,
) {
  const matches = discovery.files.filter(predicate);
  return preferNonGeneratedProjectPaths(matches, discovery.projectRoots);
}

function isNonMigrationDatabasePath(path: string) {
  return isDatabaseEvidencePath(path) && !isMigrationEvidencePath(path);
}
