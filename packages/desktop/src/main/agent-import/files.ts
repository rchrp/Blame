import type { AgentImportSourceId, AgentImportUnsupported } from "@blame/app";
import { readdir, readFile, stat } from "node:fs/promises";
import { displayPath, type ScanEnvironment } from "./environment.ts";
import type { FoundSkill } from "./skills.ts";
import { parseJsonc, type ImportedServer } from "./servers.ts";

export type CollectedSource = {
  id: AgentImportSourceId;
  label: string;
  /** Its files are on this computer, whether or not they hold anything. */
  detected: boolean;
  location: string;
  servers: ImportedServer[];
  /** Skills Blame does not read where they are: copied to `~/.agents/skills`. */
  skills: FoundSkill[];
  /** Skills and commands Blame reads in place. */
  inPlace: { name: string; description?: string; kind: "skill" | "command" }[];
  unsupported: AgentImportUnsupported[];
};

export function emptySource(
  id: AgentImportSourceId,
  label: string,
  scan: ScanEnvironment,
  folder?: string,
): CollectedSource {
  return {
    id,
    label,
    detected: false,
    location: folder ? displayPath(scan, folder) : "",
    servers: [],
    skills: [],
    inPlace: [],
    unsupported: [],
  };
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(file, "utf8"));
  } catch {
    // Missing, unreadable or corrupt: nothing to offer from this file.
    return undefined;
  }
}

export async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function hasContent(file: string) {
  const size = await stat(file).then(
    (s) => (s.isFile() ? s.size : 0),
    () => 0,
  );
  if (!size || size > 1_000_000) return size > 0;
  return (await readFile(file, "utf8").catch(() => "")).trim().length > 0;
}

export async function subfolders(directory: string) {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
