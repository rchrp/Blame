// Skills: folders of instructions (`SKILL.md`, with a YAML front matter
// giving their name and scope) the agent loads when a task matches. The
// prompt lists each skill's scope, as it was when the conversation started;
// the `skills` tool reads the current instructions from disk.
//
// The folders are the ones people already use: in the workspace
// `.clinerules/skills` and `.cline/skills` (projects that also use Cline),
// `.claude/skills` and `.agents/skills`; in their home `~/.agents/skills`;
// and the `skills` folder of each plugin, Blame's own (plugins/blame-native)
// first. A plugin contributes its skills only.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { defineTool, type ClientTool } from "../tool.js";

export type Skill = {
  /** The name in lower case: what the tool is called with. */
  id: string;
  name: string;
  description?: string;
  disabled?: boolean;
  instructions: string;
  file: string;
};

/** Blame's own skills, next to this package's build. */
export function blameNativeSkillsDirectory() {
  return fileURLToPath(
    new URL("../../plugins/blame-native/skills", import.meta.url),
  );
}

/** A plugin's skills folder, from the plugin's folder or its entry file. */
export function pluginSkillsDirectory(pluginPath: string) {
  return extname(pluginPath)
    ? join(dirname(pluginPath), "skills")
    : join(pluginPath, "skills");
}

export function skillDirectories(input: {
  workspaceRoot: string;
  pluginPaths?: readonly string[];
  builtIn?: boolean;
  home?: string;
}): string[] {
  const home = input.home ?? homedir();
  return unique([
    ...[".clinerules", ".cline", ".claude", ".agents"].map((folder) =>
      join(input.workspaceRoot, folder, "skills"),
    ),
    join(home, ".agents", "skills"),
    ...(input.builtIn ? [blameNativeSkillsDirectory()] : []),
    ...(input.pluginPaths ?? []).map(pluginSkillsDirectory),
  ]);
}

/** Every skill of these folders; the first folder wins a name both hold. */
export async function loadSkills(directories: readonly string[]) {
  const skills = new Map<string, Skill>();
  for (const directory of directories)
    for (const file of await skillFiles(directory)) {
      const skill = await readSkill(file).catch(() => undefined);
      if (skill && !skills.has(skill.id)) skills.set(skill.id, skill);
    }
  return [...skills.values()];
}

// A SKILL.md in the folder itself, or one in each of its subfolders.
async function skillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
    else if (
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(path).then(
          (info) => info.isDirectory(),
          () => false,
        )))
    )
      files.push(join(path, "SKILL.md"));
  }
  return files;
}

async function readSkill(file: string): Promise<Skill | undefined> {
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/u, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const data = match ? record(parseYaml(match[1]!)) : {};
  const instructions = (match ? match[2]! : text).trim();
  if (!instructions) return undefined;
  const name = textField(data.name) ?? basename(dirname(file)).trim();
  if (!name) return undefined;
  const disabled =
    data.disabled === true || data.enabled === false ? true : undefined;
  return {
    id: name.toLowerCase(),
    name,
    description: textField(data.description),
    ...(disabled ? { disabled } : {}),
    instructions,
    file,
  };
}

// Skills that only apply through a tool the session may not have.
const skillRequiredTools: ReadonlyMap<string, string> = new Map([
  ["component-preview", "open_component_preview"],
]);

/** The skills a conversation with these tools can use. */
export function usableSkills(
  skills: readonly Skill[],
  toolNames: readonly string[],
) {
  return skills.filter((skill) => {
    const tool = skillRequiredTools.get(skill.id);
    return !tool || toolNames.includes(tool);
  });
}

/** The prompt section that lists each skill's scope. */
export function skillScopeSection(skills: readonly Skill[]) {
  const enabled = skills.filter((skill) => !skill.disabled);
  if (!enabled.length) return "";
  const descriptions: string[] = [];
  let remaining = 16_384;
  for (const skill of enabled) {
    const description = JSON.stringify({
      name: skill.name,
      description:
        skill.description?.trim() ||
        "Scope unavailable; inspect the skill when relevance is uncertain.",
    });
    if (description.length > remaining) {
      descriptions.push(
        "Further descriptions exceed this snapshot's limit; the skills tool remains available.",
      );
      break;
    }
    descriptions.push(description);
    remaining -= description.length + 1;
  }
  return (
    "\n\n## Skill selection\n" +
    "Invoke explicitly requested skills. Otherwise load a skill when its described scope applies to the current request; frontend files elsewhere in the workspace do not make a backend or mechanical task frontend design work. These descriptions are a startup snapshot; the skills tool loads current instructions. Inspect the skill if relevance is uncertain.\n" +
    descriptions.join("\n")
  );
}

const skillsDescription =
  'Execute a skill within the main conversation. When users ask you to perform tasks, check if any available skills match. When users reference a slash command, invoke it with this tool. Input: `skill` (required) and optional `args`. Example: `skill: "pdf"`, `skill: "commit", args: "-m \\"Fix bug\\""`, `skill: "review-pr", args: "123"`, `skill: "ms-office-suite:pdf"`. When a skill matches the user\'s request, invoking this tool is a blocking requirement before any other response. Never mention a skill without invoking this tool.';

/**
 * The `skills` tool. Its description names the skills of the snapshot, so it
 * stays the same through the conversation; a call reads the current files.
 */
export function skillsTool(
  snapshot: readonly Skill[],
  load: () => Promise<readonly Skill[]>,
): ClientTool<never> | undefined {
  const names = snapshot
    .filter((skill) => !skill.disabled)
    .map((skill) => skill.name);
  if (!names.length) return undefined;
  const allowed = new Set(snapshot.map((skill) => skill.id));
  return defineTool<Record<string, unknown>>({
    name: "skills",
    description: `${skillsDescription} Available skills: ${names.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          minLength: 1,
          description: "Name of the skill to execute.",
        },
        args: {
          type: ["string", "null"],
          description: "Arguments for the skill",
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    effect: "read_only",
    timeoutMs: 15_000,
    async run(input) {
      const requested = textField(input.skill)?.replace(/^\/+/, "");
      if (!requested) return "Missing skill name.";
      const skills = (await load()).filter((skill) => allowed.has(skill.id));
      return runSkill(skills, requested, textField(input.args));
    },
  });
}

/** What the model reads when it invokes a skill. */
export function runSkill(
  skills: readonly Skill[],
  requested: string,
  args?: string,
) {
  const id = requested.trim().replace(/^\/+/, "").toLowerCase();
  const short = id.includes(":") ? (id.split(":").at(-1) ?? id) : id;
  const matches = skills.filter(
    (skill) => skill.id === id || skill.id === short,
  );
  const enabled = matches.filter((skill) => !skill.disabled);
  if (enabled.length === 1) {
    const skill = enabled[0]!;
    const commandArgs = args?.trim()
      ? `\n<command-args>${args.trim()}</command-args>`
      : "";
    const description = skill.description?.trim()
      ? `Description: ${skill.description.trim()}\n\n`
      : "";
    return `<command-name>${skill.name}</command-name>${commandArgs}\n<command-instructions>\n${description}${skill.instructions}\n</command-instructions>`;
  }
  if (matches.length)
    return `Skill "${matches[0]!.name}" is configured but disabled.`;
  const available = skills
    .filter((skill) => !skill.disabled)
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
  return available.length
    ? `Skill "${requested}" not found. Available skills: ${available.join(", ")}`
    : "No skills are currently available.";
}

/**
 * A conversation's skills: the snapshot its prompt and tool describe, and
 * the tool. Nothing when no folder holds a skill.
 */
export async function conversationSkills(
  input: Parameters<typeof skillDirectories>[0],
  toolNames: readonly string[],
) {
  const directories = skillDirectories(input);
  const load = async () =>
    usableSkills(await loadSkills(directories), toolNames);
  const snapshot = await load();
  return {
    skills: snapshot,
    prompt: skillScopeSection(snapshot),
    tool: skillsTool(snapshot, load),
  };
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function textField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
