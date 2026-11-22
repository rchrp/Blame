import { homedir } from "node:os";
import { join } from "node:path";
import type {
  SharedSetupOptions,
  WorkspaceFingerprints,
} from "@blame/preview-runtime/compose";

// Stories whose dependency manifests are identical share their node_modules
// volumes, so a setup task that only fills them runs once for all of them
// (see shared-setup.ts in preview-runtime). The stamps live on the Docker
// host, next to the volumes: inside the Blame Runtime VM on macOS and
// Windows, where the engine reaches them with scripts run as root. On Linux
// the computer is the Docker host and, unless the engine runs as root, it
// cannot read the volumes, so stories keep their own stamps there.

/** Where the stamps are, on the Docker host. */
export function localPreviewSetupDirectory() {
  return process.platform === "linux"
    ? join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "blame",
        "preview-setup",
      )
    : "/opt/blame/preview-setup";
}

/**
 * What the engine needs to share a setup task between stories. Setting
 * `BLAME_PREVIEW_SHARED_SETUP=0` turns it off: every story keeps its own
 * stamp, as before (to compare start times, or if a stamp ever misleads).
 */
export function localSharedSetup(
  worktree: string,
  environment: NodeJS.ProcessEnv = process.env,
): SharedSetupOptions | undefined {
  if (environment.BLAME_PREVIEW_SHARED_SETUP === "0") return undefined;
  return { directory: localPreviewSetupDirectory(), workspace: worktree };
}

/** What the engine knows of the worktree: its dependency key and install inputs. */
export function localWorkspaceFingerprints(local: {
  dependencyKey: string;
  sharedInstall: string | undefined;
}): WorkspaceFingerprints {
  return {
    lockfiles: async () => local.dependencyKey,
    sharedInstall: async () => local.sharedInstall,
  };
}
