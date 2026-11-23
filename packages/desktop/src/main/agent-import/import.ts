import type {
  AgentImportChoice,
  AgentImportItem,
  AgentImportOutcome,
  AgentImportResult,
  AgentImportScan,
  AgentImportSource,
  McpServerConfig,
} from "@blame/app";
import { collectSources, type CollectedSource } from "./collect.ts";
import {
  blameSkillsFolder,
  pathsFor,
  type ScanEnvironment,
} from "./environment.ts";
import {
  fingerprint,
  secretNames,
  serverSummary,
  type ImportedServer,
} from "./servers.ts";
import {
  copySkill,
  installedSkills,
  sameSkill,
  type FoundSkill,
} from "./skills.ts";

/** What Blame already has, and how to add to it. */
export type BlameMcpStore = {
  list(): Promise<{ name: string; fingerprint: string }[]>;
  /** Adds each server whose name is free; answers the names it added. */
  add(servers: McpServerConfig[]): Promise<string[]>;
};

type Planned = {
  item: AgentImportItem;
  server?: ImportedServer;
  skill?: FoundSkill;
  source: CollectedSource;
};

const slugs: Record<string, string> = {
  "claude-desktop": "claude-desktop",
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  vscode: "vscode",
};

export async function scanAgentSetups(
  scan: ScanEnvironment,
  store: BlameMcpStore,
): Promise<AgentImportScan> {
  const collected = await collectSources(scan);
  const planned = await plan(collected, scan, store);
  return {
    sources: collected.map((source): AgentImportSource => ({
      id: source.id,
      label: source.label,
      detected: source.detected,
      location: source.location,
      unsupported: source.unsupported,
      items: [
        ...planned
          .filter((entry) => entry.source === source)
          .map((entry) => entry.item),
        ...source.inPlace.map((entry) => inPlaceItem(source, entry)),
      ],
    })),
  };
}

async function plan(
  collected: CollectedSource[],
  scan: ScanEnvironment,
  store: BlameMcpStore,
): Promise<Planned[]> {
  const planned: Planned[] = [];
  // Names in use, with what they are: Blame's servers, then the ones above.
  const servers = new Map(
    (await store.list()).map((entry) => [
      entry.name.toLowerCase(),
      entry.fingerprint,
    ]),
  );
  const offered = new Set<string>();
  for (const source of collected)
    for (const server of source.servers) {
      const key = `${source.id}:mcp:${server.scope ?? "user"}:${server.name}`;
      const print = fingerprint(server);
      const taken = servers.get(server.name.toLowerCase());
      // The same server in two places is offered once.
      if (offered.has(`${server.name.toLowerCase()}|${print}`)) continue;
      offered.add(`${server.name.toLowerCase()}|${print}`);
      const state =
        taken === undefined ? "new" : taken === print ? "present" : "conflict";
      if (taken === undefined) servers.set(server.name.toLowerCase(), print);
      planned.push({
        source,
        server,
        item: {
          id: key,
          category: "mcp",
          name: server.name,
          state,
          summary: serverSummary(server),
          scope:
            server.scope && server.scope !== "user" ? server.scope : undefined,
          secrets: secretNames(server),
          warnings: [...server.warnings, ...server.notes],
          // A project's own server is offered, not pushed onto every project.
          defaultSelected:
            state === "new" &&
            (server.scope ?? "user") === "user" &&
            !server.disabled,
          renameTo:
            state === "conflict"
              ? uniqueName(server.name, source.id, servers)
              : undefined,
        },
      });
    }

  const root = blameSkillsFolder(scan);
  const installed = await installedSkills(root, scan);
  for (const source of collected)
    for (const skill of source.skills) {
      const existing =
        installed.folders.get(skill.folder.toLowerCase()) ??
        installed.names.get(skill.name.toLowerCase());
      const same = existing ? await sameSkill(skill, existing) : false;
      const state = !existing ? "new" : same ? "present" : "conflict";
      if (!existing) {
        installed.folders.set(skill.folder.toLowerCase(), skill);
        installed.names.set(skill.name.toLowerCase(), skill);
      }
      planned.push({
        source,
        skill,
        item: {
          id: `${source.id}:skill:${skill.key}`,
          category: "skill",
          name: skill.name,
          state,
          summary: skill.description ?? "",
          secrets: [],
          warnings: [],
          defaultSelected: state === "new",
          renameTo:
            state === "conflict"
              ? uniqueSkillName(
                  skill,
                  source.id,
                  installed.folders,
                  installed.names,
                )
              : undefined,
        },
      });
    }
  return planned;
}

function inPlaceItem(
  source: CollectedSource,
  entry: CollectedSource["inPlace"][number],
): AgentImportItem {
  return {
    id: `${source.id}:${entry.kind}:${entry.name}`,
    category: entry.kind,
    name: entry.name,
    state: "in-place",
    summary: entry.description ?? "",
    secrets: [],
    warnings: [],
    defaultSelected: false,
  };
}

function uniqueName(name: string, source: string, taken: Map<string, unknown>) {
  const base = `${name}-${slugs[source] ?? source}`;
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${base}-${n}`;
  return candidate;
}

function uniqueSkillName(
  skill: FoundSkill,
  source: string,
  folders: Map<string, unknown>,
  names: Map<string, unknown>,
) {
  const base = `${skill.name}-${slugs[source] ?? source}`;
  let candidate = base;
  for (
    let n = 2;
    folders.has(folderFor(candidate)) || names.has(candidate.toLowerCase());
    n++
  )
    candidate = `${base}-${n}`;
  return candidate;
}

function folderFor(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export async function applyAgentImport(
  scan: ScanEnvironment,
  store: BlameMcpStore,
  choices: AgentImportChoice[],
): Promise<AgentImportResult> {
  const planned = await plan(await collectSources(scan), scan, store);
  const outcomes: AgentImportOutcome[] = [];
  const toAdd: { entry: Planned; config: McpServerConfig }[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    if (seen.has(choice.id)) continue;
    seen.add(choice.id);
    const entry = planned.find((candidate) => candidate.item.id === choice.id);
    if (!entry || entry.item.state === "in-place") {
      outcomes.push({
        id: choice.id,
        name: choice.id,
        status: "failed",
        message: "It is no longer in the source.",
      });
    } else if (entry.item.state === "present") {
      outcomes.push({
        id: choice.id,
        name: entry.item.name,
        status: "present",
      });
    } else if (entry.item.state === "conflict" && !choice.rename) {
      outcomes.push({
        id: choice.id,
        name: entry.item.name,
        status: "skipped",
        message: "A different one has this name.",
      });
    } else if (entry.server) {
      const name =
        choice.rename && entry.item.renameTo
          ? entry.item.renameTo
          : entry.item.name;
      toAdd.push({ entry, config: mcpConfig(entry.server, name) });
    } else if (entry.skill) {
      outcomes.push(await importSkill(entry, scan, choice.rename === true));
    }
  }
  if (toAdd.length) {
    const added = new Set(
      (await store.add(toAdd.map((candidate) => candidate.config))).map(
        (name) => name.toLowerCase(),
      ),
    );
    for (const { entry, config } of toAdd)
      outcomes.push({
        id: entry.item.id,
        name: config.name,
        status: !added.has(config.name.toLowerCase())
          ? "skipped"
          : config.name === entry.item.name
            ? "imported"
            : "renamed",
        message: !added.has(config.name.toLowerCase())
          ? "A server with this name appeared meanwhile."
          : config.disabled && !entry.server?.disabled
            ? "Switched off until you have filled in what it needs."
            : undefined,
      });
  }
  return { outcomes };
}

async function importSkill(
  entry: Planned,
  scan: ScanEnvironment,
  rename: boolean,
): Promise<AgentImportOutcome> {
  const skill = entry.skill!;
  const name = rename && entry.item.renameTo ? entry.item.renameTo : undefined;
  try {
    const destination = pathsFor(scan.platform).join(
      blameSkillsFolder(scan),
      name ? folderFor(name) : skill.folder,
    );
    await copySkill(skill, destination, name);
    return {
      id: entry.item.id,
      name: name ?? skill.name,
      status: name ? "renamed" : "imported",
    };
  } catch (error) {
    return {
      id: entry.item.id,
      name: skill.name,
      status: "failed",
      message: error instanceof Error ? error.message : "The copy failed.",
    };
  }
}

/** A server with something to fill in is imported switched off. */
function mcpConfig(server: ImportedServer, name: string): McpServerConfig {
  return {
    name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    url: server.url,
    headers: server.headers,
    timeout: server.timeout,
    disabled: server.disabled || server.warnings.length > 0,
    oauth: { configured: false, supported: server.transport !== "stdio" },
    requiresLocalSetup: false,
  };
}
