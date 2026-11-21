// What the app's windows told the story service: each one's projects and
// the person's settings. The projects whose queue runs are what the open
// windows list together: a project a window no longer lists (removed from
// its recent projects, gone from disk or from the account) stops starting
// stories. When the last window closes, its list stays (the app runs on in
// the background) until a window says otherwise; what it was preparing does
// not, since that stopped with it.

import type { StoryPreferences, StoryProject } from "../story-protocol.js";

type WindowSync = {
  projects: StoryProject[];
  preferences: StoryPreferences;
  /** When it said so, by the service's clock: the latest settings win. */
  order: number;
};

export class StoryWindows {
  private readonly open = new Map<string, WindowSync>();
  /** The last window's list, once it closed and none is open. */
  private closed: WindowSync | undefined;
  private clock = 0;

  sync(
    window: string,
    projects: StoryProject[],
    preferences: StoryPreferences,
  ) {
    this.open.set(window, { projects, preferences, order: ++this.clock });
    this.closed = undefined;
  }

  close(window: string) {
    const sync = this.open.get(window);
    if (!sync) return;
    this.open.delete(window);
    if (this.open.size) return;
    this.closed = {
      ...sync,
      preferences: { ...sync.preferences, initializingProjects: [] },
    };
  }

  clear() {
    this.open.clear();
    this.closed = undefined;
  }

  private syncs(): WindowSync[] {
    if (this.open.size) return [...this.open.values()];
    return this.closed ? [this.closed] : [];
  }

  /** The projects whose stories start: id → folder. */
  projects(): Map<string, string> {
    const projects = new Map<string, string>();
    for (const sync of this.syncs().sort(
      (left, right) => left.order - right.order,
    ))
      for (const project of sync.projects)
        projects.set(project.id, project.path);
    return projects;
  }

  /**
   * The person's settings: the latest a window gave, with the projects any
   * open window prepares now and every context cap picked. The agent model
   * is the latest one named: a window whose model picker is still loading
   * holds no story back.
   */
  preferences(): StoryPreferences | undefined {
    const syncs = this.syncs().sort((left, right) => left.order - right.order);
    const latest = syncs.at(-1)?.preferences;
    if (!latest) return undefined;
    const agentModel = syncs
      .map((sync) => sync.preferences.agentModel)
      .filter((model) => model !== undefined)
      .at(-1);
    return {
      ...latest,
      ...(agentModel ? { agentModel } : {}),
      initializingProjects: [
        ...new Set(
          syncs.flatMap((sync) => sync.preferences.initializingProjects ?? []),
        ),
      ],
      contextLimits: Object.assign(
        {},
        ...syncs.map((sync) => sync.preferences.contextLimits ?? {}),
      ),
    };
  }
}
