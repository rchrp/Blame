import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  continueFolder,
  antigravityFolders,
  geminiFolder,
  gooseConfigFile,
  kiloFolder,
  openCodeFolder,
  pathsFor,
  qwenFolder,
  vscodeExtensionSettings,
  zedSettingsFile,
  type ScanEnvironment,
} from "./environment.ts";
import {
  emptySource,
  exists,
  readJson,
  record,
  type CollectedSource,
} from "./files.ts";
import {
  parseGooseExtensions,
  parseOpenCodeMcp,
  parseServersTable,
  parseZedServers,
  type ImportedServer,
} from "./servers.ts";
import { findSkills } from "./skills.ts";

// The open-source agent tools besides Cline (collect.ts). Each reads its
// user-level files only; project files are the project's, not the person's.

async function skillsOf(
  source: CollectedSource,
  scan: ScanEnvironment,
  folder: string,
) {
  source.skills.push(
    ...(await findSkills(pathsFor(scan.platform).join(folder, "skills"), scan)),
  );
}

export async function openCode(scan: ScanEnvironment) {
  const folder = openCodeFolder(scan);
  const p = pathsFor(scan.platform);
  const source = emptySource("opencode", "OpenCode", scan, folder);
  source.detected = await exists(folder);
  for (const name of ["opencode.json", "opencode.jsonc"])
    source.servers.push(
      ...parseOpenCodeMcp(record(await readJson(p.join(folder, name))).mcp)
        .servers,
    );
  await skillsOf(source, scan, folder);
  return source;
}

export async function kilo(scan: ScanEnvironment) {
  const folder = kiloFolder(scan);
  const p = pathsFor(scan.platform);
  const legacy = vscodeExtensionSettings(
    scan,
    "kilocode.kilo-code",
    "mcp_settings.json",
  );
  const source = emptySource("kilo", "Kilo Code", scan, folder);
  source.detected = (await exists(folder)) || (await exists(legacy.folder));
  // The CLI reads OpenCode-style files; the VS Code extension its own.
  for (const name of [
    "kilo.jsonc",
    "kilo.json",
    "opencode.jsonc",
    "opencode.json",
  ])
    source.servers.push(
      ...parseOpenCodeMcp(record(await readJson(p.join(folder, name))).mcp)
        .servers,
    );
  source.servers.push(
    ...parseServersTable(record(await readJson(legacy.file)).mcpServers)
      .servers,
  );
  return source;
}

export async function roo(scan: ScanEnvironment) {
  const location = vscodeExtensionSettings(
    scan,
    "rooveterinaryinc.roo-cline",
    "mcp_settings.json",
  );
  const source = emptySource("roo", "Roo Code", scan, location.folder);
  source.detected = await exists(location.folder);
  source.servers.push(
    ...parseServersTable(record(await readJson(location.file)).mcpServers)
      .servers,
  );
  return source;
}

// Gemini CLI and Qwen Code (its fork) share `settings.json`: `url` is SSE.
async function geminiLike(
  scan: ScanEnvironment,
  id: "gemini" | "qwen",
  label: string,
  folder: string,
) {
  const source = emptySource(id, label, scan, folder);
  source.detected = await exists(folder);
  source.servers.push(
    ...parseServersTable(
      record(
        await readJson(pathsFor(scan.platform).join(folder, "settings.json")),
      ).mcpServers,
      undefined,
      { bareUrl: "sse" },
    ).servers,
  );
  await skillsOf(source, scan, folder);
  return source;
}

/** Gemini CLI's successor: one `mcp_config.json` for the IDE and the CLI. */
export async function antigravity(scan: ScanEnvironment) {
  const p = pathsFor(scan.platform);
  const folders = antigravityFolders(scan);
  const source = emptySource(
    "antigravity",
    "Antigravity",
    scan,
    folders.config,
  );
  source.detected = (
    await Promise.all(Object.values(folders).map((folder) => exists(folder)))
  ).some(Boolean);
  // The IDE's older location is probed too (not in the docs any more).
  for (const file of [
    p.join(folders.config, "mcp_config.json"),
    p.join(folders.legacyIde, "mcp_config.json"),
  ])
    source.servers.push(
      ...parseServersTable(record(await readJson(file)).mcpServers).servers,
    );
  for (const folder of Object.values(folders))
    await skillsOf(source, scan, folder);
  return source;
}

export const gemini = (scan: ScanEnvironment) =>
  geminiLike(scan, "gemini", "Gemini CLI (legacy)", geminiFolder(scan));
export const qwen = (scan: ScanEnvironment) =>
  geminiLike(scan, "qwen", "Qwen Code", qwenFolder(scan));

export async function goose(scan: ScanEnvironment) {
  const file = gooseConfigFile(scan);
  const source = emptySource(
    "goose",
    "Goose",
    scan,
    pathsFor(scan.platform).dirname(file),
  );
  source.detected = await exists(file);
  const config = await readYaml(file);
  const parsed = parseGooseExtensions(record(config).extensions);
  source.servers.push(...parsed.servers);
  if (parsed.bundled)
    source.unsupported.push({
      label: "Extensions that come with Goose",
      count: parsed.bundled,
      reason: "They are part of Goose and only work inside it.",
    });
  return source;
}

export async function zed(scan: ScanEnvironment) {
  const file = zedSettingsFile(scan);
  const source = emptySource(
    "zed",
    "Zed",
    scan,
    pathsFor(scan.platform).dirname(file),
  );
  source.detected = await exists(pathsFor(scan.platform).dirname(file));
  source.servers.push(
    ...parseZedServers(record(await readJson(file)).context_servers).servers,
  );
  return source;
}

/** `~/.continue/mcpServers/*.json|yaml|yml`: Claude-style JSON, or a YAML list. */
export async function continueDev(scan: ScanEnvironment) {
  const folder = continueFolder(scan);
  const directory = pathsFor(scan.platform).join(folder, "mcpServers");
  const source = emptySource("continue", "Continue", scan, folder);
  source.detected = await exists(folder);
  const names = (await readdir(directory).catch(() => [] as string[])).sort();
  for (const name of names) {
    const file = pathsFor(scan.platform).join(directory, name);
    const servers: ImportedServer[] = [];
    if (name.endsWith(".json"))
      servers.push(
        ...parseServersTable(record(await readJson(file)).mcpServers).servers,
      );
    else if (/\.ya?ml$/.test(name)) {
      const list = record(await readYaml(file)).mcpServers;
      if (Array.isArray(list))
        servers.push(
          ...parseServersTable(
            Object.fromEntries(
              list.flatMap((entry) =>
                typeof record(entry).name === "string"
                  ? [[record(entry).name as string, entry]]
                  : [],
              ),
            ),
          ).servers,
        );
    }
    source.servers.push(...servers);
  }
  return source;
}

async function readYaml(file: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
