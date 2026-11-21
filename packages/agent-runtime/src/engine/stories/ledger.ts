// What the story service keeps on this computer, beside the account's API:
//
// - which stories this computer runs (it started their agent, or sent them
//   a turn): only those it settles, pauses or reconciles; a story another
//   computer of the account runs is left alone. Each keeps its project's
//   folder, so it is settled after a restart even when no window lists it;
// - which ended turns of each session it told its listeners about
//   (`onTurnEnded`), so a turn that ended while Blame was closed, or whose
//   story could not be written at the time, is told once, later. A turn is
//   marked told before its listeners hear of it: a crash between the two
//   loses that one telling, never repeats it.
//
// The file is written whole, to a temporary file renamed over it. One that
// cannot be read is kept aside (`.corrupt-<time>`), never overwritten.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type EndedTurn = { turn: string };

/** A story this computer runs. */
export type OwnedStory = {
  projectId: string;
  /** The project's folder on this computer. */
  path: string;
  session?: string;
};

type State = {
  /** Session → the turns told, oldest first (the last 200). */
  sessions: Map<string, string[]>;
  stories: Map<string, OwnedStory>;
};

const toldKept = 200;

export class StoryLedger {
  private readonly file: string | undefined;
  private state: State | undefined;
  private loading: Promise<State> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(file?: string) {
    this.file = file;
  }

  // ------------------------------------------------------------ ownership

  /** This computer runs the story (starts it, or sends it a turn). */
  async own(storyId: string, story: OwnedStory) {
    const state = await this.load();
    const known = state.stories.get(storyId);
    if (
      known?.path === story.path &&
      known.projectId === story.projectId &&
      known.session === (story.session ?? known.session)
    )
      return;
    state.stories.set(storyId, { ...known, ...story });
    await this.flush();
  }

  async owns(storyId: string) {
    return (await this.load()).stories.has(storyId);
  }

  async story(storyId: string): Promise<OwnedStory | undefined> {
    return (await this.load()).stories.get(storyId);
  }

  /** The story no longer runs here (done, discarded, sent back, deleted). */
  async release(storyId: string) {
    const state = await this.load();
    if (!state.stories.delete(storyId)) return;
    await this.flush();
  }

  async ownedStories(): Promise<Array<[string, OwnedStory]>> {
    return [...(await this.load()).stories];
  }

  // ----------------------------------------------------------------- turns

  /** A session the service made: every turn it ends is told. */
  async begin(session: string) {
    const state = await this.load();
    if (state.sessions.has(session)) return;
    state.sessions.set(session, []);
    await this.flush();
  }

  /**
   * The ended turns not told yet, oldest first. A session the ledger never
   * saw (one made elsewhere, or a lost file) starts from where it is: its
   * history is not told again.
   */
  async untold<Turn extends EndedTurn>(
    session: string,
    ended: readonly Turn[],
  ): Promise<Turn[]> {
    const state = await this.load();
    const told = state.sessions.get(session);
    if (!told) {
      state.sessions.set(
        session,
        ended.map(({ turn }) => turn).slice(-toldKept),
      );
      await this.flush();
      return [];
    }
    const seen = new Set(told);
    return ended.filter(({ turn }) => !seen.has(turn));
  }

  async told(session: string, turn: string) {
    const state = await this.load();
    const told = state.sessions.get(session) ?? [];
    if (told.includes(turn)) return;
    state.sessions.set(session, [...told, turn].slice(-toldKept));
    await this.flush();
  }

  /** A session deleted from the engine. */
  async forget(session: string) {
    const state = await this.load();
    if (!state.sessions.delete(session)) return;
    await this.flush();
  }

  // ------------------------------------------------------------------ file

  private load() {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.read().then((state) => (this.state = state));
    return this.loading;
  }

  private async read(): Promise<State> {
    const state: State = { sessions: new Map(), stories: new Map() };
    const file = this.file;
    if (!file) return state;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return state;
    }
    try {
      const stored = JSON.parse(text) as {
        sessions?: Record<string, unknown>;
        stories?: Record<string, OwnedStory>;
      };
      for (const [session, told] of Object.entries(stored.sessions ?? {}))
        state.sessions.set(
          session,
          Array.isArray(told)
            ? told.filter((turn): turn is string => typeof turn === "string")
            : typeof told === "string"
              ? [told]
              : [],
        );
      for (const [storyId, story] of Object.entries(stored.stories ?? {}))
        if (story && typeof story.path === "string")
          state.stories.set(storyId, story);
      return state;
    } catch (error) {
      // Kept aside for a person to look at; the service starts over.
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      console.error(
        `Story service: ${file} could not be read (${String(error)}); kept as ${aside}.`,
      );
      return state;
    }
  }

  private flush() {
    const file = this.file;
    const state = this.state;
    if (!file || !state) return Promise.resolve();
    const content = JSON.stringify({
      version: 2,
      sessions: Object.fromEntries(state.sessions),
      stories: Object.fromEntries(state.stories),
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
