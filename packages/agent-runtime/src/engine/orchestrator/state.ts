// What the orchestrator keeps on this computer, beside the API and the
// engine's records (`<userData>/orchestrator-epics.json`):
//
// - the epics whose conversation runs here (their session was created
//   here), with the last settings a window sent, so the host can write to
//   the conversation itself (a wake) after a restart;
// - the story turns the story service told and no wake carried yet: what
//   was told is kept here before the wake goes, and a wake is in the
//   conversation's records once sent, so a turn is told once across a quit;
// - each story's spend as last read (a merged story's session is deleted);
// - the requests for changes sent to each story;
// - whether the person stopped the conversation's running turn (a turn cut
//   by a quit is resumed, one the person stopped is not).
//
// Written whole to a temporary file renamed over it; one that cannot be
// read is kept aside (`.corrupt-<time>`), never overwritten.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  OrchestratorSettings,
  OrchestratorWakeStory,
} from "../protocol.js";

/** A story turn the story service told, waiting for the next wake. */
export type PendingTurn = { story: OrchestratorWakeStory };

/** What a story's session spent, as last read. */
export type SessionSpend = { microUsd: number; unpriced: number };

export type EpicEntry = {
  projectId: string;
  session: string;
  settings?: OrchestratorSettings;
  stopped?: boolean;
  pending: PendingTurn[];
  /** Story → its sessions → what each spent. */
  spend: Record<string, Record<string, SessionSpend>>;
  changes: Record<string, number>;
};

// Pending turns beyond this are the oldest dropped (a wake carries the rest).
const pendingKept = 200;

export class OrchestratorState {
  private readonly file: string | undefined;
  private epics: Map<string, EpicEntry> | undefined;
  private loading: Promise<Map<string, EpicEntry>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file;
  }

  async get(epicId: string): Promise<EpicEntry | undefined> {
    return (await this.load()).get(epicId);
  }

  async all(): Promise<Array<[string, EpicEntry]>> {
    return [...(await this.load())];
  }

  async bySession(session: string): Promise<string | undefined> {
    for (const [epicId, entry] of await this.load())
      if (entry.session === session) return epicId;
    return undefined;
  }

  /** The epic's conversation runs here from now on. */
  async register(
    epicId: string,
    input: { projectId: string; session: string },
  ) {
    await this.change(
      epicId,
      (entry) => {
        entry.projectId = input.projectId;
        entry.session = input.session;
      },
      input,
    );
  }

  /** Changes the epic's entry and writes the file; nothing for an epic not run here. */
  async change(
    epicId: string,
    mutate: (entry: EpicEntry) => void,
    create?: { projectId: string; session: string },
  ) {
    const epics = await this.load();
    let entry = epics.get(epicId);
    if (!entry) {
      if (!create) return;
      entry = { ...create, pending: [], spend: {}, changes: {} };
      epics.set(epicId, entry);
    }
    const before = JSON.stringify(entry);
    mutate(entry);
    entry.pending = entry.pending.slice(-pendingKept);
    if (JSON.stringify(entry) !== before) await this.flush();
  }

  async forget(epicId: string) {
    const epics = await this.load();
    if (epics.delete(epicId)) await this.flush();
  }

  private load() {
    if (this.epics) return Promise.resolve(this.epics);
    this.loading ??= this.read().then((epics) => (this.epics = epics));
    return this.loading;
  }

  private async read(): Promise<Map<string, EpicEntry>> {
    const epics = new Map<string, EpicEntry>();
    const file = this.file;
    if (!file) return epics;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return epics;
    }
    try {
      const stored = JSON.parse(text) as { epics?: Record<string, unknown> };
      for (const [epicId, value] of Object.entries(stored.epics ?? {})) {
        const entry = value as Partial<EpicEntry>;
        if (typeof entry?.session !== "string") continue;
        epics.set(epicId, {
          projectId: String(entry.projectId ?? ""),
          session: entry.session,
          ...(entry.settings ? { settings: entry.settings } : {}),
          ...(entry.stopped ? { stopped: true } : {}),
          pending: Array.isArray(entry.pending) ? entry.pending : [],
          spend:
            entry.spend && typeof entry.spend === "object" ? entry.spend : {},
          changes:
            entry.changes && typeof entry.changes === "object"
              ? entry.changes
              : {},
        });
      }
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      console.error(
        `Orchestrator: ${file} could not be read (${String(error)}); kept as ${aside}.`,
      );
    }
    return epics;
  }

  private flush() {
    const file = this.file;
    const epics = this.epics;
    if (!file || !epics) return Promise.resolve();
    const content = JSON.stringify({
      version: 1,
      epics: Object.fromEntries(epics),
    });
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, content);
        await rename(`${file}.tmp`, file);
      });
    return this.writing;
  }
}
