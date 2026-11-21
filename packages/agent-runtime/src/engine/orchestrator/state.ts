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
  /** The API (its URL) the epic was created through: what is kept here belongs to it. */
  apiUrl?: string;
  /** The epic's branch as this host made it: the only branch its stories merge into. */
  branch?: string;
  settings?: OrchestratorSettings;
  stopped?: boolean;
  pending: PendingTurn[];
  /** Story → its sessions → what each spent. */
  spend: Record<string, Record<string, SessionSpend>>;
  /** What the conversation itself spent, as last read. */
  orchestrator?: SessionSpend;
  /** Requests for changes sent, by story. */
  changes: Record<string, number>;
  /** Every message sent to a story, by story. */
  messages?: Record<string, number>;
  /** Story turns its own tools showed it (`epic_board`, `story_report`): no wake repeats them. */
  heard?: string[];
  /**
   * What the epic's pause stopped, to start again on resume: the stories
   * it paused, whether it cut the conversation's turn, and the stories
   * whose start was in flight when it came (paused once they run).
   */
  pause?: { stories: string[]; turn: boolean; awaiting?: string[] };
};

// Pending turns beyond this are the oldest dropped (a wake carries the rest).
const pendingKept = 200;
const heardKept = 500;

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

  /** The entry as read so far, without waiting: undefined until the file is read. */
  peek(epicId: string): EpicEntry | undefined {
    return this.epics?.get(epicId);
  }

  /** The file was read: `peek` answers for every epic. */
  ready() {
    return this.epics !== undefined;
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
    input: {
      projectId: string;
      session: string;
      apiUrl: string;
      branch: string;
    },
  ) {
    await this.change(
      epicId,
      (entry) => {
        Object.assign(entry, input);
      },
      { projectId: input.projectId, session: input.session },
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
    if (entry.heard) entry.heard = entry.heard.slice(-heardKept);
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
          ...(Array.isArray(entry.heard) ? { heard: entry.heard } : {}),
          ...(typeof entry.apiUrl === "string" ? { apiUrl: entry.apiUrl } : {}),
          ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
          ...(entry.orchestrator ? { orchestrator: entry.orchestrator } : {}),
          ...(entry.messages && typeof entry.messages === "object"
            ? { messages: entry.messages }
            : {}),
          ...(entry.pause && Array.isArray(entry.pause.stories)
            ? { pause: entry.pause }
            : {}),
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
