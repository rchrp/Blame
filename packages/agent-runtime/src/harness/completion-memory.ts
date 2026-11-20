import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "./light-identity.js";
import type { ProjectMemoryCandidate } from "./project-memory.js";

// What an accepted finish_task leaves for the project's memory, handed from
// the harness runner (which has no API connection) to the engine host,
// which saves it to the account when the turn ends. One file per session,
// next to its journal; the host removes it once it read it.

function memoryFile(workspaceRoot: string, session: string) {
  return join(
    workspaceRoot,
    ".blame",
    "harness",
    "light",
    `${sha256(session).slice(0, 24)}.memory.json`,
  );
}

export async function leaveCompletionMemory(
  workspaceRoot: string,
  session: string,
  memory: ProjectMemoryCandidate,
) {
  const file = memoryFile(workspaceRoot, session);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(memory));
}

/** The memory the session's last accepted finish_task left, once. */
export async function takeCompletionMemory(
  workspaceRoot: string,
  session: string,
): Promise<ProjectMemoryCandidate | undefined> {
  const file = memoryFile(workspaceRoot, session);
  try {
    const memory = JSON.parse(
      await readFile(file, "utf8"),
    ) as ProjectMemoryCandidate;
    await rm(file, { force: true });
    return memory;
  } catch {
    return undefined;
  }
}
