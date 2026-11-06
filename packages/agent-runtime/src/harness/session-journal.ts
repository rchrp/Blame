import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "./light-identity.js";
import { WorkspaceFiles } from "./workspace-files.js";
import type { LightAlias } from "./light-aliases.js";
import type { ReadCoverageState } from "./read-coverage.js";
import type { LightAttentionState } from "./light-attention.js";

export type JournalFileState = { hash: string; path: string };

export type JournalChange = {
  beforeFiles?: JournalFileState[];
  files: JournalFileState[];
  parse: "failed" | "not_supported" | "passed";
  paths: string[];
  receipt: string;
  sourceRevisionId: string;
  symbols: string[];
  timestamp: string;
};

export type JournalCompletionSnapshot = {
  changedPaths: string[];
  changes: ReturnType<typeof publicChange>[];
  files: JournalFileState[];
  sourceRevisionId: string;
  symbols: string[];
  validations: ReturnType<typeof publicValidation>[];
};

export type JournalValidation = {
  scope?: "invocation_only";
  args?: string[];
  check?: import("./check-observation.js").CheckObservation;
  category?: "code" | "command" | "environment";
  command?: string;
  cwd?: string;
  evidenceOrigin?: "formatter_output";
  files: JournalFileState[];
  id: string;
  paths: string[];
  sourceRevisionId?: string;
  status: string;
  taskId?: string;
  taskKind?: string;
  recovery?: string;
  terminal: "failed" | "passed" | "pending" | "unknown";
  timestamp: string;
};

type ChangeInput = Omit<JournalChange, "files" | "timestamp">;
type ValidationInput = Omit<
  JournalValidation,
  "files" | "id" | "paths" | "terminal" | "timestamp"
> & {
  id?: string;
  paths?: string[];
  terminal?: JournalValidation["terminal"];
};

type JournalEvent =
  | { type: "observation_audit"; tool: "read_code" | "search_code"; requestedView: string;
      renderedView: string; bytes: number; aliases: number; limited: boolean; timestamp: string }
  | { type: "request"; id: string; text: string; timestamp: string }
  | ({ type: "change" } & JournalChange)
  | ({ type: "validation" } & JournalValidation)
  | { type: "aliases"; entries: LightAlias[]; timestamp: string }
  /** Since the previous alias event: every alias in order, and the entries that changed. */
  | { type: "alias_changes"; order: string[]; changed: LightAlias[]; timestamp: string }
  | { type: "coverage"; state: ReadCoverageState; timestamp: string }
  | { type: "attention"; state: LightAttentionState; timestamp: string }
  | { type: "terminal"; state: string; summary?: string; timestamp: string };

export class SessionJournal {
  private readonly file: string;
  private readonly files: WorkspaceFiles;
  private readonly changes: JournalChange[] = [];
  private readonly validations: JournalValidation[] = [];
  private aliases: LightAlias[] = [];
  private aliasesDigest = "";
  /** Alias change events since the last full list. */
  private aliasChanges = 0;
  private coverage: ReadCoverageState = { entries: [], receiptSequence: 0 };
  private coverageDigest = "";
  private attention?: LightAttentionState;
  private attentionDigest = "";
  private readonly requestIds = new Set<string>();
  private terminalState?: string;

  constructor(workspaceRoot: string, sessionId: string) {
    const directory = join(workspaceRoot, ".blame", "harness", "light");
    this.file = join(directory, `${sha256(sessionId).slice(0, 24)}.jsonl`);
    this.files = new WorkspaceFiles(workspaceRoot);
  }

  async ingestUserRequest(id: string, text: string) {
    if (this.requestIds.has(id)) return;
    this.requestIds.add(id);
    await this.append({ type: "request", id, text, timestamp: now() });
  }

  async recordObservationAudit(input: Omit<Extract<JournalEvent, { type: "observation_audit" }>, "type" | "timestamp">) {
    await this.append({ ...input, type: "observation_audit", timestamp: now() });
  }

  async recordChange(input: ChangeInput) {
    const event = {
      type: "change" as const,
      ...input,
      files: await this.fileStates(input.paths),
      timestamp: now(),
    };
    this.changes.push(event);
    await this.append(event);
  }

  async recordValidation(input: ValidationInput) {
    const paths = input.paths ?? this.changedPaths();
    const terminal = input.terminal ?? validationTerminal(input.status);
    const identity = input.command ?? input.taskId ??
      (input.evidenceOrigin ? JSON.stringify([input.evidenceOrigin, paths]) : undefined);
    const event = {
      type: "validation" as const,
      ...input,
      id:
        input.id ??
        `validation://${sha256(`${identity}\0${now()}`)}`,
      paths,
      terminal,
      files: await this.fileStates(paths),
      timestamp: now(),
    };
    this.validations.push(event);
    await this.append(event);
  }

  async recordTerminal(state: string, summary?: string) {
    if (this.terminalState) return;
    this.terminalState = state;
    await this.append({ type: "terminal", state, summary, timestamp: now() });
  }

  async recordAliases(entries: LightAlias[]) {
    const aliases = entries.slice(-500).map((entry) => ({ ...entry }));
    const digest = sha256(JSON.stringify(aliases));
    if (digest === this.aliasesDigest) return;
    const previous = new Map(this.aliases.map((entry) => [entry.alias, JSON.stringify(entry)]));
    this.aliases = aliases;
    this.aliasesDigest = digest;
    // Rewriting all 500 aliases on every read made a story's journal 12 MB
    // (US-041). Most events now carry only what changed, with a full list
    // now and then so a reload replays few of them.
    if (previous.size && this.aliasChanges < fullAliasListEvery) {
      this.aliasChanges += 1;
      await this.append({
        type: "alias_changes",
        order: aliases.map((entry) => entry.alias),
        changed: aliases.filter((entry) => previous.get(entry.alias) !== JSON.stringify(entry)),
        timestamp: now(),
      });
      return;
    }
    this.aliasChanges = 0;
    await this.append({
      type: "aliases",
      entries: this.aliases,
      timestamp: now(),
    });
  }

  currentAliases() {
    return this.aliases.map((entry) => ({ ...entry }));
  }

  async recordCoverage(state: ReadCoverageState) {
    const digest = sha256(JSON.stringify(state));
    if (digest === this.coverageDigest) return;
    this.coverage = state;
    this.coverageDigest = digest;
    await this.append({ type: "coverage", state, timestamp: now() });
  }

  async recordAttention(state: LightAttentionState) {
    const digest = sha256(JSON.stringify(state));
    if (digest === this.attentionDigest) return;
    this.attention = state;
    this.attentionDigest = digest;
    await this.append({ type: "attention", state, timestamp: now() });
  }

  currentAttention() {
    return this.attention && structuredClone(this.attention);
  }

  currentCoverage() {
    return structuredClone(this.coverage);
  }

  currentChanges() {
    return this.changes.map(publicChange);
  }

  currentValidations() {
    return this.validations.map(publicValidation);
  }

  async currentChangedPaths() {
    await this.hydrate();
    return (await this.currentChangesByPath()).map(({ path }) => path);
  }

  async completionSnapshot(): Promise<JournalCompletionSnapshot> {
    await this.hydrate();
    const snapshot = await this.files.snapshot();
    const current = await this.currentChangesByPath();
    const changes = [...new Set(current.map(({ change }) => change))].map(
      publicChange,
    );
    const validations = await this.currentValidationEvents(
      snapshot.revision.source_revision_id,
    );
    return {
      changedPaths: current.map(({ path }) => path),
      changes,
      files: currentFileStates(current),
      sourceRevisionId: snapshot.revision.source_revision_id,
      symbols: [...new Set(changes.flatMap(({ symbols }) => symbols))],
      validations: validations.map(publicValidation),
    };
  }

  async hydrate() {
    const events = await this.readEvents();
    this.changes.splice(0, this.changes.length, ...events.filter(isChange));
    this.validations.splice(
      0,
      this.validations.length,
      ...events.filter(isValidation),
    );
    const { aliases, changes } = replayedAliases(events);
    this.aliases = aliases.slice(-500);
    this.aliasChanges = changes;
    this.aliasesDigest = sha256(JSON.stringify(this.aliases));
    this.coverage =
      [...events].reverse().find(isCoverage)?.state ?? this.coverage;
    this.coverageDigest = sha256(JSON.stringify(this.coverage));
    const attention = [...events].reverse().find((event) => event.type === "attention");
    this.attention = attention?.type === "attention" ? attention.state : this.attention;
    this.attentionDigest = this.attention ? sha256(JSON.stringify(this.attention)) : "";
    this.requestIds.clear();
    for (const event of events)
      if (event.type === "request") this.requestIds.add(event.id);
    this.terminalState = [...events]
      .reverse()
      .find((event) => event.type === "terminal")?.state;
  }

  private async currentChangesByPath() {
    const latest = new Map<string, JournalChange>();
    const initial = new Map<string, string>();
    for (const change of this.changes)
      for (const path of change.paths) {
        const before = change.beforeFiles?.find((file) => file.path === path);
        if (!latest.has(path) && before) initial.set(path, before.hash);
        latest.set(path, change);
      }
    const entries = [...latest].map(([path, change]) => ({ path, change }));
    const current = await Promise.all(
      entries.map(async (entry) =>
        entry.change.files.find((file) => file.path === entry.path)?.hash !==
          initial.get(entry.path) &&
        (await this.fileStateCurrent(entry.path, entry.change.files))
          ? entry
          : undefined,
      ),
    );
    return current.filter(
      (entry): entry is (typeof entries)[number] => !!entry,
    );
  }

  private async currentValidationEvents(sourceRevisionId: string) {
    const current = await Promise.all(
      this.validations.map(async (validation) =>
        validation.sourceRevisionId === sourceRevisionId &&
        (await this.allFilesCurrent(validation.files))
          ? validation
          : undefined,
      ),
    );
    const fresh = current.filter(
      (validation): validation is JournalValidation => Boolean(validation),
    );
    const latest = new Map<string, JournalValidation>();
    for (const validation of fresh)
      latest.set(
        JSON.stringify([
          validation.cwd ?? ".",
          validation.taskId ?? validation.command ??
            (validation.evidenceOrigin ? [validation.evidenceOrigin, validation.paths] : undefined),
          validation.args ?? [],
        ]),
        validation,
      );
    return [...latest.values()];
  }

  private changedPaths() {
    return [...new Set(this.changes.flatMap(({ paths }) => paths))];
  }

  private async fileStates(paths: string[]) {
    return Promise.all(
      [...new Set(paths)].map(async (path) => {
        try {
          return { path, hash: sha256((await this.files.read(path)).content) };
        } catch {
          return { path, hash: "absent" };
        }
      }),
    );
  }

  private async allFilesCurrent(states: JournalFileState[]) {
    const results = await Promise.all(
      states.map((state) => this.fileStateCurrent(state.path, states)),
    );
    return results.every(Boolean);
  }

  private async fileStateCurrent(path: string, states: JournalFileState[]) {
    const expected = states.find((state) => state.path === path)?.hash;
    if (!expected) return false;
    try {
      return sha256((await this.files.read(path)).content) === expected;
    } catch {
      return expected === "absent";
    }
  }

  /** Appends one line after the previous append ends: reads can record while a command does. */
  private append(event: JournalEvent) {
    const line = `${JSON.stringify(event)}\n`;
    const appended = this.appending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, line, { mode: 0o600 });
    });
    this.appending = appended.catch(() => undefined);
    return appended;
  }

  private appending: Promise<unknown> = Promise.resolve();

  private async readEvents(): Promise<JournalEvent[]> {
    try {
      const content = await readFile(this.file, "utf8");
      return content.split("\n").filter(Boolean).flatMap(parseEvent);
    } catch {
      return [];
    }
  }
}

function currentFileStates(
  entries: Array<{ change: JournalChange; path: string }>,
) {
  return entries.flatMap(({ change, path }) => {
    const state = change.files.find((file) => file.path === path);
    return state ? [{ ...state }] : [];
  });
}

function publicChange(change: JournalChange) {
  return {
    parse: change.parse,
    paths: [...change.paths],
    receipt: change.receipt,
    symbols: [...change.symbols],
    timestamp: change.timestamp,
  };
}

function publicValidation(validation: JournalValidation) {
  return {
    ...(validation.scope ? { scope: validation.scope } : {}),
    ...(validation.args?.length ? { args: [...validation.args] } : {}),
    check: validation.check,
    category: validation.category,
    command: validation.command,
    cwd: validation.cwd,
    ...(validation.evidenceOrigin ? { evidenceOrigin: validation.evidenceOrigin } : {}),
    id: validation.id,
    paths: [...validation.paths],
    recovery: validation.recovery,
    sourceRevisionId: validation.sourceRevisionId,
    status: validation.status,
    taskId: validation.taskId,
    taskKind: validation.taskKind,
    terminal: validation.terminal,
    timestamp: validation.timestamp,
  };
}

function validationTerminal(status: string) {
  if (status === "passed") return "passed" as const;
  if (status === "failed") return "failed" as const;
  return "unknown" as const;
}

function parseEvent(line: string): JournalEvent[] {
  try {
    return [JSON.parse(line) as JournalEvent];
  } catch {
    return [];
  }
}

function isChange(event: JournalEvent): event is JournalEvent & JournalChange {
  return event.type === "change";
}

function isValidation(
  event: JournalEvent,
): event is JournalEvent & JournalValidation {
  return event.type === "validation";
}

const fullAliasListEvery = 50;

/** The alias list after the last full list and the changes recorded since. */
function replayedAliases(events: JournalEvent[]) {
  let aliases: LightAlias[] = [];
  let changes = 0;
  for (const event of events) {
    if (event.type === "aliases") {
      aliases = event.entries;
      changes = 0;
    } else if (event.type === "alias_changes") {
      const byAlias = new Map(aliases.map((entry) => [entry.alias, entry]));
      for (const entry of event.changed) byAlias.set(entry.alias, entry);
      aliases = event.order.flatMap((alias) => byAlias.get(alias) ?? []);
      changes += 1;
    }
  }
  return { aliases, changes };
}

function isCoverage(
  event: JournalEvent,
): event is Extract<JournalEvent, { type: "coverage" }> {
  return event.type === "coverage";
}

function now() {
  return new Date().toISOString();
}
