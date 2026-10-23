import {
  hostOrchestratedManifestCommand,
  referencedScriptFiles,
  type PreviewManifest,
} from "@blame/agent-runtime";
import {
  findProjectFilesByName,
  joinWorkspacePath,
  readExistingFiles,
  run,
} from "./workspace-runtime.ts";

// Checks the saved preview setup against the worktree before a start. A setup
// that runs a script which drives Docker on the host (for example a `dev`
// wrapper added after Blame initialized the project) fails once its container
// exits; this finding lets that failure say why. It never blocks a start:
// some wrappers only use Docker when it is available.

const maximumScriptFiles = 24;

export async function stalePreviewSetupReason(
  worktree: string,
  manifest: PreviewManifest | undefined,
) {
  if (!manifest) return undefined;
  try {
    const files = await worktreeScriptEvidence(worktree);
    const finding = hostOrchestratedManifestCommand(manifest, files);
    if (!finding) return undefined;
    return `The saved preview setup is out of date: its ${finding.owner} runs ${finding.chain.join(" -> ")}, which starts Docker on this computer, and preview containers have no Docker. Repair the setup to update it.`;
  } catch {
    return undefined;
  }
}

async function worktreeScriptEvidence(worktree: string) {
  const files: Record<string, string> = {};
  const read = async (relativePaths: string[]) => {
    const absolute = relativePaths.map((path) =>
      joinWorkspacePath(worktree, path),
    );
    const contents = await readExistingFiles(absolute);
    relativePaths.forEach((path, index) => {
      files[path] = contents[absolute[index]!] ?? "";
    });
  };
  const packages = await findProjectFilesByName(worktree, "package.json", {
    run: (command, args) => run(command, args, { cwd: worktree }),
  });
  await read(packages.map((path) => relativePath(worktree, path)));
  const scripts = referencedScriptFiles(files).slice(0, maximumScriptFiles);
  if (scripts.length) await read(scripts);
  return files;
}

function relativePath(root: string, path: string) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
