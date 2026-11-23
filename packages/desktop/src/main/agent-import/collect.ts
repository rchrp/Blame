import type { AgentImportSourceId, AgentImportUnsupported } from "@blame/app";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  claudeCodePaths,
  claudeDesktopFolders,
  clineCliSettings,
  codexFolder,
  cursorMcpFile,
  displayPath,
  pathsFor,
  vscodeExtensionSettings,
  vscodeMcpFile,
  type ScanEnvironment,
} from "./environment.ts";
import { findCommands, findSkills, type FoundSkill } from "./skills.ts";
import {
  parseCodexConfig,
  parseJsonc,
  parseServersTable,
  type ImportedServer,
} from "./servers.ts";

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

/** Everything the other tools keep that Blame can see. Read-only. */
export async function collectSources(scan: ScanEnvironment) {
  const sources = (
    await Promise.all([
      claudeDesktop(scan),
      claudeCode(scan),
      codex(scan),
      cursor(scan),
      vscode(scan),
      cline(scan),
    ])
  ).map(withoutCredentialUrls);
  return sources;
}

// Settings → MCP syncs a signed-in account's server addresses with Blame's
// cloud and refuses an address that carries a login or a query, so a server
// whose token sits in its URL is left to be added by hand.
function withoutCredentialUrls(source: CollectedSource): CollectedSource {
  const kept = source.servers.filter(
    (server) => !server.url || !carriesCredential(server.url),
  );
  const left = source.servers.length - kept.length;
  return {
    ...source,
    servers: kept,
    unsupported: left
      ? [
          ...source.unsupported,
          {
            label: "Servers with a token in their address",
            count: left,
            reason:
              "Add them in Settings → MCP and put the token in a header, so it is not synced with the address.",
          },
        ]
      : source.unsupported,
  };
}

function carriesCredential(value: string) {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || url.search || url.hash);
  } catch {
    return true;
  }
}

async function claudeDesktop(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const source = emptySource("claude-desktop", "Claude Desktop", scan);
  for (const folder of claudeDesktopFolders(scan)) {
    const file = p.join(folder, "claude_desktop_config.json");
    if (!(await exists(folder))) continue;
    source.location = displayPath(scan, folder);
    source.detected = true;
    const config = await readJson(file);
    if (config === undefined) break;
    source.servers.push(
      ...parseServersTable(record(config).mcpServers).servers,
    );
    const extensions = await subfolders(p.join(folder, "Claude Extensions"));
    if (extensions.length)
      source.unsupported.push({
        label: "Desktop extensions",
        count: extensions.length,
        reason: "Blame cannot run Claude extensions (.mcpb) yet.",
      });
    break;
  }
  return source;
}

async function claudeCode(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const { folder, json } = claudeCodePaths(scan);
  const source = emptySource("claude-code", "Claude Code", scan, folder);
  source.detected = (await exists(folder)) || (await exists(json));
  const config = record(await readJson(json));
  source.servers.push(...parseServersTable(config.mcpServers, "user").servers);
  // Servers added with `claude mcp add` in a project, kept under its path.
  for (const [project, value] of Object.entries(record(config.projects)))
    source.servers.push(
      ...parseServersTable(record(value).mcpServers, project).servers,
    );

  const skillsRoot = p.join(folder, "skills");
  // Blame reads `~/.claude/skills/<name>` in place; the skills claude.ai syncs
  // there live a level deeper and are copied.
  for (const skill of await findSkills(skillsRoot, scan, {
    skip: (n) => n === "synced",
  }))
    source.inPlace.push({
      name: skill.name,
      description: skill.description,
      kind: "skill",
    });
  source.skills.push(
    ...(await findSkills(p.join(skillsRoot, "synced"), scan, { depth: 2 })).map(
      (skill) => ({ ...skill, key: `synced/${skill.key}` }),
    ),
  );
  for (const command of await findCommands(p.join(folder, "commands")))
    source.inPlace.push({ ...command, kind: "command" });

  if (await hasContent(p.join(folder, "CLAUDE.md")))
    source.unsupported.push({
      label: "Global instructions (CLAUDE.md)",
      count: 1,
      reason: "Blame has no global instructions yet.",
    });
  const agents = (
    await readdir(p.join(folder, "agents")).catch(() => [])
  ).filter((name) => name.endsWith(".md"));
  if (agents.length)
    source.unsupported.push({
      label: "Subagents",
      count: agents.length,
      reason: "Blame does not run Claude Code subagent definitions.",
    });
  const plugins = Object.keys(
    record(
      record(
        await readJson(p.join(folder, "plugins", "installed_plugins.json")),
      ).plugins,
    ),
  );
  if (plugins.length)
    source.unsupported.push({
      label: "Plugins",
      count: plugins.length,
      reason: "Blame has no Claude Code plugin system.",
    });
  const settings = record(await readJson(p.join(folder, "settings.json")));
  const hooks = Object.keys(record(settings.hooks)).length;
  if (hooks)
    source.unsupported.push({
      label: "Hooks",
      count: hooks,
      reason: "Blame has no hooks.",
    });
  return source;
}

async function codex(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const folder = codexFolder(scan);
  const source = emptySource("codex", "Codex", scan, folder);
  source.detected = await exists(folder);
  const config = await readFile(p.join(folder, "config.toml"), "utf8").catch(
    () => undefined,
  );
  if (config !== undefined) {
    const parsed = parseCodexConfig(config);
    source.servers.push(...parsed.servers);
    if (parsed.bundled)
      source.unsupported.push({
        label: "Servers bundled with the Codex app",
        count: parsed.bundled,
        reason: "The app installs and manages them; they only work inside it.",
      });
  }
  // `.system` holds the skills Codex ships.
  source.skills.push(
    ...(await findSkills(p.join(folder, "skills"), scan, {
      skip: (n) => n.startsWith("."),
    })),
  );
  if (await hasContent(p.join(folder, "AGENTS.md")))
    source.unsupported.push({
      label: "Global instructions (AGENTS.md)",
      count: 1,
      reason: "Blame has no global instructions yet.",
    });
  return source;
}

async function cursor(scan: ScanEnvironment) {
  const file = cursorMcpFile(scan);
  const source = emptySource(
    "cursor",
    "Cursor",
    scan,
    pathsFor(scan.platform).dirname(file),
  );
  source.detected = await exists(pathsFor(scan.platform).dirname(file));
  source.servers.push(
    ...parseServersTable(record(await readJson(file)).mcpServers).servers,
  );
  return source;
}

async function vscode(scan: ScanEnvironment) {
  const file = vscodeMcpFile(scan);
  const source = emptySource(
    "vscode",
    "VS Code",
    scan,
    pathsFor(scan.platform).dirname(file),
  );
  source.detected = await exists(pathsFor(scan.platform).dirname(file));
  source.servers.push(
    ...parseServersTable(record(await readJson(file)).servers).servers,
  );
  return source;
}

async function cline(scan: ScanEnvironment) {
  const locations = [
    clineCliSettings(scan),
    vscodeExtensionSettings(
      scan,
      "saoudrizwan.claude-dev",
      "cline_mcp_settings.json",
    ),
  ];
  const source = emptySource("cline", "Cline", scan, locations[0]!.folder);
  for (const location of locations) {
    if (!(await exists(location.folder))) continue;
    if (!source.detected) source.location = displayPath(scan, location.folder);
    source.detected = true;
    source.servers.push(
      ...parseServersTable(record(await readJson(location.file)).mcpServers)
        .servers,
    );
  }
  return source;
}

function emptySource(
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

async function readJson(file: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(file, "utf8"));
  } catch {
    // Missing, unreadable or corrupt: nothing to offer from this file.
    return undefined;
  }
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function hasContent(file: string) {
  const size = await stat(file).then(
    (s) => (s.isFile() ? s.size : 0),
    () => 0,
  );
  if (!size || size > 1_000_000) return size > 0;
  return (await readFile(file, "utf8").catch(() => "")).trim().length > 0;
}

async function subfolders(directory: string) {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
