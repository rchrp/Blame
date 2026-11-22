// What the orchestrator keeps on this computer, beside the API and the
// engine's records (`<userData>/orchestrator-epics.json`):
//
// - the epics whose conversation runs here (their session was created
//   here), with the API they were made through, the branch this host made,
//   and the last settings a window sent, so the host can write to the
//   conversation itself (a wake) after a restart;
// - the story turns the story service told and no wake carried yet: what
//   was told is kept here before the wake goes, and a wake is in the
//   conversation's records once sent, so a turn is told once across a quit;
// - the turns the orchestrator's own tools showed it (heard);
// - each story's and the conversation's spend as last read (a merged
//   story's session is deleted);
// - the messages and requests for changes sent to each story;
// - what the epic's pause means to stop, and has stopped;
// - what the last `idle` wake told, so the same is not told again;
// - whether the person stopped the conversation's running turn (a turn cut
//   by a quit is resumed, one the person stopped is not).
//
// Written whole to a temporary file renamed over it. A file that is not
// there starts empty. One that cannot be read (a disk or permission error)
// holds everything: nothing is written over it and every read fails with
// the reason, until it reads again. One that reads but is not JSON is kept
// aside (`.corrupt-<time>`) and the epics are found again from the
// engine's records (`Orchestrator.adopt`).

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

/**
 * What the epic's pause means to stop and has stopped, written before it
 * acts so a quit or a failure part way is taken up again:
 * - `pausing`: the stories at work when it came (`stories`), those whose
 *   start was in flight (`awaiting`, paused once they run), and whether it
 *   cuts the conversation's turn (`turn`: the one running then, `cut`; a
 *   later turn, the person's, runs), until each is stopped;
 * - `paused`: everything it meant to stop is stopped;
 * - `resuming`: the epic is active again and those are being resumed.
 */
export type EpicPause = {
  phase: "pausing" | "paused" | "resuming";
  stories: string[];
  awaiting?: string[];
  turn: boolean;
  /** The conversation's turn running when the pause came: the only one it cuts. */
  cut?: string;
};

export type EpicEntry = {
  projectId: string;
  session: string;
  /** The API (its URL) the epic was created through: what is kept here belongs to it. */
  apiUrl?: string;
  /** The epic's branch as this host made it: the only branch its stories merge into. */
  branch?: string;
  /** The branch is gone and stories were merged into it: nothing starts. */
  branchGone?: boolean;
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
  /** Story turns its own tools showed it, `session\nturn` → story: no wake repeats them. */
  heard?: Record<string, string>;
  pause?: EpicPause;
  /** What the last `idle` wake told (the stories' states, the blocked reasons): told once. */
  idleTold?: string;
};

export class OrchestratorState {
  private readonly file: string | undefined;
  private epics: Map<string, EpicEntry> | undefined;
  private loading: Promise<Map<string, EpicEntry>> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private unreadable: string | undefined;

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

  /** Why the file cannot be read now, while it cannot. */
  failure() {
    return this.unreadable;
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
    if (JSON.stringify(entry) !== before) await this.flush();
  }

  async forget(epicId: string) {
    const epics = await this.load();
    if (epics.delete(epicId)) await this.flush();
  }

  private load() {
    if (this.epics) return Promise.resolve(this.epics);
    this.loading ??= this.read().then(
      (epics) => (this.epics = epics),
      (error: unknown) => {
        // Not held: the next call reads the file again.
        this.loading = undefined;
        throw error;
      },
    );
    return this.loading;
  }

  private async read(): Promise<Map<string, EpicEntry>> {
    const epics = new Map<string, EpicEntry>();
    const file = this.file;
    if (!file) return epics;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return epics;
      // Never started over: what it holds is the only proof of what runs here.
      this.unreadable = `The orchestrator's file ${file} cannot be read (${String(error)}).`;
      throw new Error(this.unreadable, { cause: error });
    }
    this.unreadable = undefined;
    try {
      const stored = JSON.parse(text) as { epics?: Record<string, unknown> };
      for (const [epicId, value] of Object.entries(stored.epics ?? {})) {
        const entry = parseEntry(value);
        if (entry) epics.set(epicId, entry);
      }
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      console.error(
        `Orchestrator: ${file} could not be read (${String(error)}); kept as ${aside}, the epics are found again from the engine's records.`,
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

function record<T>(value: unknown): Record<string, T> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : undefined;
}

function parseEntry(value: unknown): EpicEntry | undefined {
  const entry = value as Partial<EpicEntry>;
  if (typeof entry?.session !== "string") return undefined;
  const pause = entry.pause;
  return {
    projectId: String(entry.projectId ?? ""),
    session: entry.session,
    ...(typeof entry.apiUrl === "string" ? { apiUrl: entry.apiUrl } : {}),
    ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
    ...(entry.branchGone ? { branchGone: true } : {}),
    ...(entry.settings ? { settings: entry.settings } : {}),
    ...(entry.stopped ? { stopped: true } : {}),
    pending: Array.isArray(entry.pending) ? entry.pending : [],
    spend: record(entry.spend) ?? {},
    ...(entry.orchestrator ? { orchestrator: entry.orchestrator } : {}),
    changes: record(entry.changes) ?? {},
    ...(record(entry.messages) ? { messages: record(entry.messages) } : {}),
    ...(record(entry.heard) ? { heard: record(entry.heard) } : {}),
    ...(pause && Array.isArray(pause.stories) && pause.phase ? { pause } : {}),
    ...(typeof entry.idleTold === "string" ? { idleTold: entry.idleTold } : {}),
  };
}
