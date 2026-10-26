import { rm } from "node:fs/promises";

export type ProjectScanLocation = { root: string; temporary: boolean };

// Ownership travels with the path across IPC. A WSL UNC path is another
// view of the original worktree, not a temporary copy that we can delete.
export function projectScanResource(
  location: ProjectScanLocation,
  remove: typeof rm = rm,
) {
  return {
    ...location,
    release: async () => {
      if (location.temporary === true)
        await remove(location.root, { recursive: true, force: true });
    },
  };
}
