import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { pathsFor, type ScanEnvironment } from "./environment.ts";

/**
 * Skills (`SKILL.md` folders) and Claude commands (`*.md` files) of the other
 * tools. Reading only: copying happens in `copySkill`, into `~/.agents/skills`
 * (a folder Blame already reads), and never over something that is there.
 */
export type FoundSkill = {
  /** The path under the tool's skills folder, `/`-separated. */
  key: string;
  /** The folder's name: what it is called on disk. */
  folder: string;
  /** The front matter's name, else the folder's. */
  name: string;
  description?: string;
  directory: string;
  file: string;
};

const maxFiles = 2000;
const maxBytes = 50 * 1024 * 1024;

/** Folders of `root` holding a `SKILL.md`, `depth` levels down at most. */
export async function findSkills(
  root: string,
  scan: ScanEnvironment,
  options: { depth?: number; skip?: (name: string) => boolean } = {},
): Promise<FoundSkill[]> {
  const p = pathsFor(scan.platform);
  const found: FoundSkill[] = [];
  async function walk(directory: string, keys: string[], depth: number) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || options.skip?.(entry.name)) continue;
      const child = p.join(directory, entry.name);
      const file = p.join(child, "SKILL.md");
      const skill = await readSkillFile(file);
      if (skill)
        found.push({
          key: [...keys, entry.name].join("/"),
          folder: entry.name,
          directory: child,
          file,
          name: skill.name ?? entry.name,
          description: skill.description,
        });
      else if (depth > 1) await walk(child, [...keys, entry.name], depth - 1);
    }
  }
  await walk(root, [], options.depth ?? 1);
  return found;
}

async function readSkillFile(file: string) {
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const data = frontMatter(content);
  return {
    name:
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : undefined,
    description:
      typeof data.description === "string"
        ? data.description.trim().slice(0, 160)
        : undefined,
  };
}

function frontMatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.replace(/^﻿/, ""));
  if (!match) return {};
  try {
    const data = parseYaml(match[1]!);
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `~/.claude/commands/*.md`: the file's name is the command's. */
export async function findCommands(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const commands: { name: string; description?: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const content = await readFile(`${directory}/${entry.name}`, "utf8").catch(
      () => "",
    );
    const description = frontMatter(content).description;
    commands.push({
      name: entry.name.slice(0, -3),
      description:
        typeof description === "string" ? description.slice(0, 160) : undefined,
    });
  }
  return commands;
}

/** What `~/.agents/skills` holds, by folder and by the skill's own name. */
export async function installedSkills(root: string, scan: ScanEnvironment) {
  const skills = await findSkills(root, scan);
  return {
    folders: new Map(
      skills.map((skill) => [skill.folder.toLowerCase(), skill]),
    ),
    names: new Map(skills.map((skill) => [skill.name.toLowerCase(), skill])),
  };
}

export async function sameSkill(a: FoundSkill, b: FoundSkill) {
  return (
    (await folderDigest(a.directory)) === (await folderDigest(b.directory))
  );
}

async function folderDigest(directory: string) {
  const hash = createHash("sha256");
  for (const file of await listFiles(directory)) {
    hash.update(file.relative);
    hash.update(await readFile(file.path).catch(() => ""));
  }
  return hash.digest("hex");
}

async function listFiles(directory: string, prefix = "") {
  const files: { path: string; relative: string }[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    const relative = `${prefix}${entry.name}`;
    if (
      entry.isDirectory() &&
      entry.name !== ".git" &&
      entry.name !== "node_modules"
    )
      files.push(...(await listFiles(path, `${relative}/`)));
    // A link could lead anywhere on the disk: it is not copied.
    else if (entry.isFile()) files.push({ path, relative });
  }
  return files;
}

/**
 * Copies a skill folder to `destination`, which must not exist. With `name`,
 * the copy's SKILL.md says that name (a renamed skill must not shadow the one
 * it conflicts with). Removes what it wrote if anything fails.
 */
export async function copySkill(
  skill: FoundSkill,
  destination: string,
  name?: string,
) {
  if (
    await lstat(destination).then(
      () => true,
      () => false,
    )
  )
    throw new Error("A skill folder with this name already exists");
  const files = await listFiles(skill.directory);
  if (files.length > maxFiles) throw new Error("This skill has too many files");
  let bytes = 0;
  for (const file of files) bytes += (await lstat(file.path)).size;
  if (bytes > maxBytes) throw new Error("This skill is too large to copy");
  try {
    for (const file of files) {
      const target = `${destination}/${file.relative}`;
      await mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      if (name && file.relative === "SKILL.md")
        await writeFile(
          target,
          withName(await readFile(file.path, "utf8"), name),
        );
      else await copyFile(file.path, target);
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function withName(content: string, name: string) {
  const quoted = JSON.stringify(name);
  const match = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);
  if (!match) return `---\nname: ${quoted}\n---\n\n${content}`;
  const body = /^name:.*$/m.test(match[2]!)
    ? match[2]!.replace(/^name:.*$/m, `name: ${quoted}`)
    : `name: ${quoted}\n${match[2]}`;
  return `${match[1]}${body}${match[3]}${content.slice(match[0].length)}`;
}
