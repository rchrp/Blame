// What `blame_inspect area=skills` says of the skill folders: which skills a
// new conversation lists, and why a folder that looks like one does not
// load. It reads skills the way `skills.ts` does (that file decides what
// loads); here a folder that did not load is read again to say why.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  blameNativeSkillsDirectory,
  loadSkills,
  skillDirectories,
} from "./skills.js";

export type SkillsReport = {
  loaded: { name: string; scope: string; description?: string }[];
  problems: { path: string; problem: string }[];
};

type Input = {
  workspaceRoot: string;
  pluginPaths?: readonly string[];
  home?: string;
};

export async function inspectSkills(input: Input): Promise<SkillsReport> {
  const home = input.home ?? homedir();
  const directories = skillDirectories({ ...input, home, builtIn: true });
  const skills = await loadSkills(directories);
  const loadedFiles = new Set(skills.map((skill) => skill.file));
  const scope = (path: string) => scopeOf(path, input.workspaceRoot, home);
  const problems: SkillsReport["problems"] = [];
  for (const directory of directories) {
    // Blame's own and plugins' skills are not the person's to fix.
    if (directory === blameNativeSkillsDirectory()) continue;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.name.startsWith(".")) continue;
      const folder = join(directory, entry.name);
      const isFolder =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(folder).then(
            (info) => info.isDirectory(),
            () => false,
          )));
      if (!isFolder) continue;
      const file = join(folder, "SKILL.md");
      if (loadedFiles.has(file)) continue;
      problems.push({
        path: shorten(file, input.workspaceRoot, home),
        problem: await whyNotLoaded(file, skills),
      });
    }
  }
  return {
    loaded: skills.map((skill) => ({
      name: skill.name,
      scope: scope(skill.file),
      ...(skill.description
        ? { description: skill.description.slice(0, 120) }
        : {}),
      ...(skill.disabled ? { disabled: true } : {}),
    })),
    problems,
  };
}

async function whyNotLoaded(
  file: string,
  loaded: readonly { id: string; name: string; file: string }[],
): Promise<string> {
  let text: string;
  try {
    text = (await readFile(file, "utf8")).replace(/^﻿/u, "");
  } catch {
    return "the folder has no SKILL.md";
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let name: string | undefined;
  if (match) {
    try {
      const data = parseYaml(match[1]!) as { name?: unknown } | null;
      if (typeof data?.name === "string") name = data.name.toLowerCase();
    } catch (error) {
      return `the front matter is not valid YAML: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`;
    }
  }
  if (!(match ? match[2]! : text).trim())
    return "SKILL.md has no instructions after its front matter";
  const folderName = file.split(/[\\/]/).at(-2)?.toLowerCase();
  const shadow = loaded.find((skill) => skill.id === (name ?? folderName));
  return shadow
    ? `another skill named "${shadow.name}" loads first (${shadow.file})`
    : "SKILL.md could not be read as a skill";
}

function scopeOf(file: string, workspaceRoot: string, home: string) {
  if (file.startsWith(blameNativeSkillsDirectory())) return "built-in";
  if (file.startsWith(join(home, ".agents"))) return "user";
  if (file.startsWith(workspaceRoot)) return "project";
  return "plugin";
}

function shorten(file: string, workspaceRoot: string, home: string) {
  if (file.startsWith(workspaceRoot)) return relative(workspaceRoot, file);
  return file.startsWith(home) ? `~/${relative(home, file)}` : file;
}
