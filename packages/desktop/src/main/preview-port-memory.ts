import {
  composeHostPorts,
  composeWithAllocatedHostPorts,
} from "./workspace-compose.ts";
import { joinWorkspacePath, readFile, writeFile } from "./workspace-runtime.ts";

// Each start of a story preview publishes its services on host ports. Reusing
// the ports of the previous start keeps the preview origin stable, so the
// open preview, external tabs, cookies and login sessions survive a restart
// or a regenerated setup.

export async function composeWithRememberedHostPorts(
  worktree: string,
  compose: string,
) {
  const allocated = await composeWithAllocatedHostPorts(
    compose,
    await rememberedHostPorts(worktree),
  );
  await writeFile(
    previewPortsPath(worktree),
    `${JSON.stringify(composeHostPorts(allocated))}\n`,
  ).catch(() => undefined);
  return allocated;
}

async function rememberedHostPorts(worktree: string) {
  try {
    const value = JSON.parse(
      await readFile(previewPortsPath(worktree)),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && entry[1] > 1023 && entry[1] < 65536,
      ),
    );
  } catch {
    return {};
  }
}

function previewPortsPath(worktree: string) {
  return joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
    "preview-ports.json",
  );
}
