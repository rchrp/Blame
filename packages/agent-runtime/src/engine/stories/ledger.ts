// Which ended turns of each story's session the story service has told its
// listeners about (`onTurnEnded`). It is kept on disk, so a turn that ended
// while Blame was closed, or whose story could not be written at the time,
// is told once, later. A turn is marked told before its listeners hear of
// it: a crash between the two loses that one telling, never repeats it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type EndedTurn = { turn: string };

export class TurnLedger {
  private readonly file: string | undefined;
  /** Session → the last turn told (null: a session of ours with none told yet). */
  private sessions: Map<string, string | null> | undefined;
  private loading: Promise<Map<string, string | null>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file;
  }

  /** A session the service created: every turn it ends is told. */
  async begin(session: string) {
    const sessions = await this.load();
    if (sessions.has(session)) return;
    sessions.set(session, null);
    await this.flush();
  }

  /**
   * The ended turns not told yet, oldest first. A session the ledger never
   * saw (one made before it existed, or a lost file) starts from its last
   * ended turn: its history is not told again.
   */
  async untold<Turn extends EndedTurn>(
    session: string,
    ended: readonly Turn[],
  ): Promise<Turn[]> {
    const sessions = await this.load();
    if (!sessions.has(session)) {
      sessions.set(session, ended.at(-1)?.turn ?? null);
      await this.flush();
      return [];
    }
    const last = sessions.get(session);
    if (last === null) return [...ended];
    const index = ended.findIndex((item) => item.turn === last);
    if (index >= 0) return ended.slice(index + 1);
    // The told turn is gone (undone, or older than the window): only the
    // latest one is new for sure.
    const latest = ended.at(-1);
    return latest && latest.turn !== last ? [latest] : [];
  }

  async told(session: string, turn: string) {
    const sessions = await this.load();
    sessions.set(session, turn);
    await this.flush();
  }

  /** A session deleted with its story. */
  async forget(session: string) {
    const sessions = await this.load();
    if (!sessions.delete(session)) return;
    await this.flush();
  }

  private load() {
    if (this.sessions) return Promise.resolve(this.sessions);
    this.loading ??= (async () => {
      const sessions = new Map<string, string | null>();
      if (this.file) {
        try {
          const stored = JSON.parse(await readFile(this.file, "utf8")) as {
            sessions?: Record<string, string | null>;
          };
          for (const [session, turn] of Object.entries(stored.sessions ?? {}))
            sessions.set(session, typeof turn === "string" ? turn : null);
        } catch {
          // No ledger yet (or unreadable): sessions start from their last turn.
        }
      }
      this.sessions = sessions;
      return sessions;
    })();
    return this.loading;
  }

  // One write at a time, to a temporary file renamed over the ledger.
  private flush() {
    const file = this.file;
    if (!file || !this.sessions) return Promise.resolve();
    const content = JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(this.sessions),
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
