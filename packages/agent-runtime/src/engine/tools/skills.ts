// Skills: folders of instructions (`SKILL.md`, with a YAML front matter
// giving their name and scope) the agent loads when a task matches. The
// prompt lists each skill's scope, as it was when the conversation started;
// the `skills` tool reads the current instructions from disk.
//
// A skill written for Claude Code (or any agent following the Agent Skills
// format) works as it is. The folders are the ones people already use, first
// folder first (a name two of them hold goes to the first):
//
//   1. the workspace's `.clinerules/skills`, `.cline/skills`,
//      `.claude/skills`, `.agents/skills`;
//   2. its `.claude/commands` (the older Claude Code format: one Markdown
//      file per command, a subfolder names a `folder:command`);
//   3. the user's `~/.claude/skills` and `~/.agents/skills`;
//   4. their `~/.claude/commands`;
//   5. the `skills` folder of each plugin, Blame's own
//      (plugins/blame-native) first. A plugin contributes its skills only.
//
// So a project's skill beats the user's of the same name (Claude Code ranks
// the user's first), and in each of the two scopes a skill folder beats a
// command file.
//
// What the front matter does: `name`, `description` (+ `when_to_use`),
// `argument-hint`, `arguments`, `disable-model-invocation` (the skill is
// left out of the prompt and the tool description, but runs when the user
// asks for it by name) and `user-invocable: false` (kept for the model, left
// out of the user's picker). `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`
// and `${CLAUDE_SKILL_DIR}` are substituted. `allowed-tools`, `context`,
// `model`, `effort`, `agent`, `hooks`, `paths`, `shell` and `` !`command` ``
// blocks are ignored (docs/engine-in-the-app.md says why); so is any key
// this file does not know, and a front matter YAML cannot parse still gives
// a skill.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { defineTool, type ClientTool } from "../tool.js";
import { hasSkillFiles, readSkillFile } from "./skill-files.js";

export type Skill = {
  /** The name in lower case: what the tool is called with. */
  id: string;
  name: string;
  description?: string;
  disabled?: boolean;
  instructions: string;
  /** The `SKILL.md`, or the command's Markdown file. */
  file: string;
  /** A `.claude/commands` file rather than a skill folder. */
  command?: boolean;
  /** The skill's folder holds more than its `SKILL.md`. */
  resources?: boolean;
  /** `argument-hint`: what follows the name, `[issue-number]`. */
  argumentHint?: string;
  /** `arguments`: names for `$name`, by position. */
  argumentNames?: string[];
  /** `disable-model-invocation`: only the user's explicit request runs it. */
  disableModelInvocation?: boolean;
  /** `user-invocable: false`: the model's alone, not in the user's picker. */
  userInvocable?: boolean;
};

/**
 * Where skills are read from: a folder holding skill folders, or (`commands`)
 * a folder of command files.
 */
export type SkillSource = string | { directory: string; commands: true };

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
}): SkillSource[] {
  const home = input.home ?? homedir();
  const commands = (directory: string): SkillSource => ({
    directory,
    commands: true,
  });
  return uniqueSources([
    ...[".clinerules", ".cline", ".claude", ".agents"].map((folder) =>
      join(input.workspaceRoot, folder, "skills"),
    ),
    commands(join(input.workspaceRoot, ".claude", "commands")),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    commands(join(home, ".claude", "commands")),
    ...(input.builtIn ? [blameNativeSkillsDirectory()] : []),
    ...(input.pluginPaths ?? []).map(pluginSkillsDirectory),
  ]);
}

/** Every skill of these folders; the first folder wins a name both hold. */
export async function loadSkills(sources: readonly SkillSource[]) {
  const skills = new Map<string, Skill>();
  for (const source of sources) {
    const commands = typeof source !== "string";
    const directory = commands ? source.directory : source;
    const files = commands
      ? await commandFiles(directory)
      : await skillFiles(directory);
    for (const file of files) {
      const skill = await readSkill(
        file,
        commands ? commandName(directory, file) : undefined,
      ).catch(() => undefined);
      if (skill && !skills.has(skill.id)) skills.set(skill.id, skill);
    }
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
    else if (await isDirectory(entry, path)) files.push(join(path, "SKILL.md"));
  }
  return files;
}

// Every `.md` file under a commands folder, subfolders included.
async function commandFiles(directory: string, depth = 0): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (await isDirectory(entry, path)) {
      if (depth < 4 && !entry.name.startsWith("."))
        files.push(...(await commandFiles(path, depth + 1)));
    } else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

async function isDirectory(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  path: string,
) {
  return (
    entry.isDirectory() ||
    (entry.isSymbolicLink() &&
      (await stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      )))
  );
}

// `frontend/component.md` is `frontend:component`.
function commandName(directory: string, file: string) {
  return relative(directory, file)
    .slice(0, -extname(file).length)
    .split(sep)
    .join(":");
}

async function readSkill(
  file: string,
  commandNamed?: string,
): Promise<Skill | undefined> {
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/u, "");
  const match =
    /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(
      text,
    );
  const data = match ? frontMatter(match[1] ?? "") : {};
  const instructions = (match ? match[2]! : text).trim();
  if (!instructions) return undefined;
  const folderName = commandNamed ?? basename(dirname(file)).trim();
  // A command file's name is its path: its front matter does not rename it.
  const named = commandNamed ? undefined : validName(textField(data.name));
  const name = named ?? folderName;
  if (!name) return undefined;
  const disabled =
    data.disabled === true || data.enabled === false ? true : undefined;
  const description = [
    textField(data.description) ?? firstLine(instructions),
    textField(data.when_to_use),
  ]
    .filter(Boolean)
    .join(" ");
  const argumentNames = nameList(data.arguments);
  return {
    id: name.toLowerCase(),
    name,
    description: description || undefined,
    ...(disabled ? { disabled } : {}),
    instructions,
    file,
    ...(commandNamed ? { command: true } : {}),
    ...(!commandNamed && (await hasSkillFiles(file))
      ? { resources: true }
      : {}),
    ...(argumentHint(data["argument-hint"])
      ? { argumentHint: argumentHint(data["argument-hint"]) }
      : {}),
    ...(argumentNames.length ? { argumentNames } : {}),
    ...(flag(data["disable-model-invocation"]) === true
      ? { disableModelInvocation: true }
      : {}),
    ...(flag(data["user-invocable"]) === false ? { userInvocable: false } : {}),
  };
}

// The YAML, or, when it does not parse (an unquoted `description: Use when:
// …` is the usual cause), its top-level `key: value` lines: the skill still
// loads, which Claude Code does too, with whatever could be read.
function frontMatter(source: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(source);
    if (parsed === null || parsed === undefined) return {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the line reader.
  }
  const data: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/u.exec(lines[index]!);
    if (!line) continue;
    let value = line[2]!.trim();
    if (!value || /^[>|][+-]?$/u.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^[ \t]+\S/u.test(lines[index + 1]!))
        block.push(lines[++index]!.trim());
      value = block.join(" ");
    }
    data[line[1]!] = value.replace(/^(["'])(.*)\1$/u, "$2");
  }
  return data;
}

// Claude Code refuses names with control, invisible or angle-bracket
// characters, or odd spacing; the folder's name stands in for them.
function validName(name: string | undefined) {
  if (!name) return undefined;
  const odd =
    /[\p{C}<>\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000]/u;
  return odd.test(name) || name !== name.trim() || name.includes("  ")
    ? undefined
    : name;
}

function firstLine(markdown: string) {
  const line = markdown.split(/\r?\n/u).find((candidate) => candidate.trim());
  return line?.replace(/^#+\s*/u, "").trim() || undefined;
}

// `argument-hint: [issue-number]` is a YAML list: written back with its
// brackets, one per item.
function argumentHint(value: unknown) {
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string");
    return items.length
      ? items.map((item) => `[${item}]`).join(" ")
      : undefined;
  }
  return textField(value);
}

// `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`, in any case.
function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(text)) return true;
  if (["false", "no", "off", "0"].includes(text)) return false;
  return undefined;
}

// A space-separated string or a list.
function nameList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/u)
      : [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z_]\w*$/u.test(item) && item !== "ARGUMENTS");
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
  // A skill only the user may run still gets the section: the user's
  // `/name` is what names it.
  if (!skills.some((skill) => !skill.disabled)) return "";
  const enabled = skills.filter(modelListed);
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
    "Invoke explicitly requested skills: when the user writes `/name`, optionally with arguments, that is a request to run the skill of that name with the skills tool, the rest of their message as its args, even when it is not listed here. Otherwise load a skill when its described scope applies to the current request; frontend files elsewhere in the workspace do not make a backend or mechanical task frontend design work. These descriptions are a startup snapshot; the skills tool loads current instructions. Inspect the skill if relevance is uncertain." +
    (descriptions.length ? "\n" + descriptions.join("\n") : "")
  );
}

/** What the model is told about: not off, not left to the user's own request. */
function modelListed(skill: Skill) {
  return !skill.disabled && !skill.disableModelInvocation;
}

/** What the user's picker offers: every skill that is on, but the model's own. */
export function userInvocableSkills(skills: readonly Skill[]) {
  return skills.filter(
    (skill) => !skill.disabled && skill.userInvocable !== false,
  );
}

const skillsDescription =
  'Execute a skill within the main conversation. When users ask you to perform tasks, check if any available skills match. When users reference a slash command, invoke it with this tool. Input: `skill` (required) and optional `args`. Example: `skill: "pdf"`, `skill: "commit", args: "-m \\"Fix bug\\""`, `skill: "review-pr", args: "123"`, `skill: "ms-office-suite:pdf"`. When a skill matches the user\'s request, invoking this tool is a blocking requirement before any other response. Never mention a skill without invoking this tool. A skill the user names that is not listed is still run on their explicit request, never on yours.';

/**
 * The `skills` tool. Its description names the skills of the snapshot, so it
 * stays the same through the conversation; a call reads the current files.
 */
export function skillsTool(
  snapshot: readonly Skill[],
  load: () => Promise<readonly Skill[]>,
): ClientTool<never> | undefined {
  const names = snapshot.filter(modelListed).map((skill) => skill.name);
  // A skill only the user may ask for still needs the tool.
  if (!snapshot.some((skill) => !skill.disabled)) return undefined;
  const allowed = new Set(snapshot.map((skill) => skill.id));
  return defineTool<Record<string, unknown>>({
    name: "skills",
    description: names.length
      ? `${skillsDescription} Available skills: ${names.join(", ")}.`
      : skillsDescription,
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
        file: {
          type: ["string", "null"],
          description:
            "Instead of running the skill, read one of its files (`references/guide.md`), relative to the skill's folder.",
        },
        offset: {
          type: ["integer", "null"],
          description: "With `file`: the character to continue reading from.",
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
      const file = textField(input.file);
      if (!file) return runSkill(skills, requested, textField(input.args));
      const { found } = findSkill(skills, requested);
      if (found.length !== 1) return runSkill(skills, requested);
      const skill = found[0]!;
      return skill.resources
        ? readSkillFile(
            skill.file,
            file,
            typeof input.offset === "number" ? input.offset : 0,
          )
        : `Skill "${skill.name}" has no files besides its instructions.`;
    },
  });
}

// An exact name beats a prefixed one (`frontend:build` and `build`).
function findSkill(skills: readonly Skill[], requested: string) {
  const id = requested.trim().replace(/^\/+/, "").toLowerCase();
  const short = id.includes(":") ? (id.split(":").at(-1) ?? id) : id;
  const matches = skills.filter(
    (skill) => skill.id === id || skill.id === short,
  );
  const enabled = matches.filter((skill) => !skill.disabled);
  const exact = enabled.filter((skill) => skill.id === id);
  return { matches, enabled, found: exact.length ? exact : enabled };
}

/** What the model reads when it invokes a skill. */
export function runSkill(
  skills: readonly Skill[],
  requested: string,
  args?: string,
) {
  const { matches, enabled, found } = findSkill(skills, requested);
  if (found.length === 1) {
    const skill = found[0]!;
    const commandArgs = args?.trim()
      ? `\n<command-args>${args.trim()}</command-args>`
      : "";
    const description = skill.description?.trim()
      ? `Description: ${skill.description.trim()}\n\n`
      : "";
    const folder = skill.resources
      ? `Base directory for this skill: ${dirname(skill.file)}\nRelative paths in these instructions start there: read a file with the skills tool's \`file\` input, run a script by its full path.\n\n`
      : "";
    return `<command-name>${skill.name}</command-name>${commandArgs}\n<command-instructions>\n${description}${folder}${skillInstructions(skill, args)}\n</command-instructions>`;
  }
  if (matches.length && !enabled.length)
    return `Skill "${matches[0]!.name}" is configured but disabled.`;
  const available = skills
    .filter(modelListed)
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
  return available.length
    ? `Skill "${requested}" not found. Available skills: ${available.join(", ")}`
    : "No skills are currently available.";
}

/**
 * A skill's instructions with its arguments in, as Claude Code does it:
 * `$ARGUMENTS` (the text as typed), `$ARGUMENTS[N]` and `$N` (0-based,
 * shell-style quoting), `$name` for each of the `arguments` names, and
 * `${CLAUDE_SKILL_DIR}`. A `\$1` stays a literal `$1`; an indexed argument
 * nobody gave stays as written, a named one becomes empty; what is inserted
 * is not read again. A body with no placeholder gets `ARGUMENTS: <text>`.
 */
export function skillInstructions(skill: Skill, args?: string) {
  const text = args?.trim() ?? "";
  const positional = splitArguments(text);
  const names = skill.argumentNames ?? [];
  let placeholder = false;
  const body = skill.instructions.replace(
    /(\\*)\$(?:ARGUMENTS\[(\d+)\]|ARGUMENTS(?![\w[])|(\d+)|([A-Za-z_]\w*))/gu,
    (
      token,
      slashes: string,
      bracket?: string,
      digits?: string,
      name?: string,
    ) => {
      let value: string | undefined;
      if (name !== undefined) {
        const index = names.indexOf(name);
        if (index < 0) return token;
        value = positional[index] ?? "";
      } else if (bracket !== undefined || digits !== undefined)
        value = positional[Number(bracket ?? digits)];
      else value = text;
      // One backslash makes the token literal; the backslash goes.
      if (slashes.length === 1) return token.slice(1);
      placeholder = true;
      return value === undefined ? token : `${slashes}${value}`;
    },
  );
  const withDirectory = body.replaceAll(
    "${CLAUDE_SKILL_DIR}",
    dirname(skill.file),
  );
  return !placeholder && text
    ? `${withDirectory}\n\nARGUMENTS: ${text}`
    : withDirectory;
}

// Words, with "double" and 'single' quotes holding spaces; an unclosed quote
// runs to the end.
function splitArguments(text: string) {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"?|'([^']*)'?|((?:\\.|[^\s"'\\])+)/gu;
  let current: string | undefined;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    if (current !== undefined && /\s/u.test(text.slice(last, start))) {
      words.push(current);
      current = undefined;
    }
    const part = match[1] ?? match[2] ?? match[3] ?? "";
    current = (current ?? "") + part.replace(/\\(.)/gu, "$1");
    last = start + match[0].length;
  }
  if (current !== undefined) words.push(current);
  return words;
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

function uniqueSources(sources: SkillSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key =
      typeof source === "string" ? source : `commands:${source.directory}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

function textField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A skill as the user's `/` picker shows it. */
export type SkillPickerItem = {
  name: string;
  description?: string;
  argumentHint?: string;
};

/**
 * The skills a user may start with `/name` in a workspace: Blame's own and
 * the folders of `skillDirectories`, but the model's own
 * (`user-invocable: false`) and those that need a tool the conversation may
 * not have.
 */
export async function pickerSkills(input: {
  workspaceRoot: string;
  home?: string;
}): Promise<SkillPickerItem[]> {
  const skills = await loadSkills(
    skillDirectories({ ...input, builtIn: true }),
  );
  return userInvocableSkills(skills)
    .filter((skill) => !skillRequiredTools.has(skill.id))
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
