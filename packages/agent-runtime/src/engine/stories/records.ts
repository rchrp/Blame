// The stories the story service holds, by project, as the API last gave
// them: each with its payload, which the windows read. A read answers what
// the API had when it was asked: each record carries the moment its request
// was sent, and an answer to an older request never replaces a newer one (a
// list asked before a write never brings back what the write changed).

import type { StoryRecord } from "./api.js";
import type { HostStory } from "./story.js";

type Held = StoryRecord & { stamp: number };

export class StoryRecords {
  private readonly byProject = new Map<string, Map<string, Held>>();
  /** Projects whose stories were read once (recovery runs at the first read). */
  private readonly loaded = new Set<string>();
  /** When each story was deleted here: an older list does not bring it back. */
  private readonly deleted = new Map<string, number>();
  private clock = 0;

  /** The moment a read is asked: pass it back with what the read answered. */
  now() {
    return ++this.clock;
  }

  loadedOnce(projectId: string) {
    return this.loaded.has(projectId);
  }

  drop(projectId: string) {
    this.byProject.delete(projectId);
    this.loaded.delete(projectId);
  }

  clear() {
    this.byProject.clear();
    this.loaded.clear();
    this.deleted.clear();
  }

  /**
   * A project's stories as a list read since `askedAt`. A story written
   * since keeps its record; a detail read since keeps what the summary
   * leaves out.
   */
  replace(projectId: string, records: readonly StoryRecord[], askedAt: number) {
    const known = this.byProject.get(projectId) ?? new Map<string, Held>();
    const next = new Map<string, Held>();
    for (const record of records) {
      if ((this.deleted.get(record.story.id) ?? 0) > askedAt) continue;
      const held = known.get(record.story.id);
      next.set(
        record.story.id,
        held && held.stamp > askedAt
          ? held
          : { ...merge(held, record), stamp: askedAt },
      );
    }
    // A story created or written since the list was asked is not lost.
    for (const [id, held] of known)
      if (!next.has(id) && held.stamp > askedAt) next.set(id, held);
    this.byProject.set(projectId, next);
    this.loaded.add(projectId);
  }

  /** A story read or written, asked at `askedAt`; an older answer is ignored. */
  remember(record: StoryRecord, askedAt: number) {
    const { projectId, id } = record.story;
    const stories = this.byProject.get(projectId) ?? new Map<string, Held>();
    const held = stories.get(id);
    if (held && held.stamp > askedAt) return held;
    if ((this.deleted.get(id) ?? 0) > askedAt) return undefined;
    const next = { ...merge(held, record), stamp: askedAt };
    stories.set(id, next);
    this.byProject.set(projectId, stories);
    return next;
  }

  delete(story: Pick<HostStory, "id" | "projectId">) {
    this.byProject.get(story.projectId)?.delete(story.id);
    this.deleted.set(story.id, this.now());
  }

  record(storyId: string): StoryRecord | undefined {
    for (const stories of this.byProject.values()) {
      const record = stories.get(storyId);
      if (record) return record;
    }
    return undefined;
  }

  bySession(session: string): HostStory | undefined {
    return this.all().find((story) => story.engineSessionId === session);
  }

  projectStories(projectId: string): HostStory[] {
    return [...(this.byProject.get(projectId)?.values() ?? [])].map(
      ({ story }) => story,
    );
  }

  /** Each project with its stories. */
  projects(): Array<[string, HostStory[]]> {
    return [...this.byProject.keys()].map((projectId) => [
      projectId,
      this.projectStories(projectId),
    ]);
  }

  all(): HostStory[] {
    return [...this.byProject.keys()].flatMap((projectId) =>
      this.projectStories(projectId),
    );
  }
}

function merge(known: StoryRecord | undefined, next: StoryRecord): StoryRecord {
  if (!known) return next;
  return {
    story: { ...known.story, ...next.story },
    payload: { ...(known.payload as object), ...(next.payload as object) },
  };
}
