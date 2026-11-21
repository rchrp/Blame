// The stories the story service holds, by project, as the API last gave
// them: each with its payload, which the windows read.

import type { StoryRecord } from "./api.js";
import type { HostStory } from "./story.js";

export class StoryRecords {
  private readonly byProject = new Map<string, Map<string, StoryRecord>>();

  has(projectId: string) {
    return this.byProject.has(projectId);
  }

  drop(projectId: string) {
    this.byProject.delete(projectId);
  }

  /** A project's stories as a list just read; a detail read since keeps what the summary leaves out. */
  replace(projectId: string, records: readonly StoryRecord[]) {
    const known = this.byProject.get(projectId);
    this.byProject.set(
      projectId,
      new Map(
        records.map((record) => [
          record.story.id,
          mergeRecord(known?.get(record.story.id), record),
        ]),
      ),
    );
  }

  remember(record: StoryRecord) {
    const { projectId, id } = record.story;
    const stories = this.byProject.get(projectId) ?? new Map();
    stories.set(id, mergeRecord(stories.get(id), record));
    this.byProject.set(projectId, stories);
  }

  delete(story: Pick<HostStory, "id" | "projectId">) {
    this.byProject.get(story.projectId)?.delete(story.id);
  }

  record(storyId: string) {
    for (const stories of this.byProject.values()) {
      const record = stories.get(storyId);
      if (record) return record;
    }
    return undefined;
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

function mergeRecord(
  known: StoryRecord | undefined,
  next: StoryRecord,
): StoryRecord {
  if (!known) return next;
  return {
    story: { ...known.story, ...next.story },
    payload: { ...(known.payload as object), ...(next.payload as object) },
  };
}
