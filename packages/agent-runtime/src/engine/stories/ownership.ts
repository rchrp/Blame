// Which stories at work this computer runs though its ledger does not name
// them (`ledger.ts`): those the previous build left at work (the ledger came
// with this one) and those of a lost or unreadable ledger. Such a story is
// this computer's when this computer's engine runs its session, or when its
// own worktree (not the project folder) is here, in the runtime VM
// included; and, for a story already at work when its project was first
// read after the ledger started empty (a leftover), when this computer's
// engine keeps its session. Only then: a session followed here from a
// drawer is kept here too, so with a ledger kept all along a story it does
// not name is another computer's. Blame's database is never asked: every
// computer of the account reads the same, and reading a session another
// computer runs would end its turn here (docs/engine-in-the-app.md, "One
// computer, its stories").

import type { DesktopServices } from "../desktop-services.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineLocation,
} from "../protocol.js";
import type { StoryLedger } from "./ledger.js";
import { storyLocation, type HostStory } from "./story.js";

type OwnershipHost = {
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  desktop: DesktopServices;
  /** The sessions this computer's engine at a location keeps. */
  storedSessions?(location: EngineLocation): Promise<string[]>;
};

/** What one look at the stories asks this computer once, whatever their number. */
export type HereChecks = {
  /**
   * A look of the service's own (a project read, each minute), not one a
   * person's action asked for: looking in the runtime VM starts it, so it
   * waits until the VM runs.
   */
  background: boolean;
  running?: Promise<string[]>;
  stored: Map<EngineLocation, Promise<string[]>>;
};

export function hereChecks(background = false): HereChecks {
  return { background, stored: new Map() };
}

/** A story whose agent may be at work: one to settle, pause or clean. */
export function atWork(story: HostStory) {
  return story.agentStatus === "Running" || story.status === "in-progress";
}

export class StoryOwnership {
  /** Stories found not to be this computer's, with the session they had then. */
  private readonly notHere = new Map<string, string>();
  /** Stories at work when the ledger started empty: a session kept here counts. */
  private readonly leftovers = new Set<string>();

  constructor(
    private readonly deps: {
      ledger: StoryLedger;
      host: OwnershipHost;
      /** The story's project folder on this computer, if it has one. */
      projectPath(story: HostStory): string | undefined;
      /** What a check waits for, it waits for this long at most. */
      within<T>(work: Promise<T>, what: string): Promise<T>;
      /** Whether the runtime VM runs now (the windows' Blame Runtime phase). */
      runtimeReady(): boolean;
    },
  ) {}

  /**
   * Whether this computer runs the story: the ledger names it, or it is
   * this computer's all the same, and the ledger names it from now.
   */
  async adopt(story: HostStory, checks = hereChecks()) {
    const { ledger } = this.deps;
    if (await ledger.owns(story.id)) return true;
    const path = this.deps.projectPath(story);
    if (!path) return false;
    const verdict = await this.here(story, path, checks);
    const session = story.engineSessionId ?? "";
    if (verdict === false) this.notHere.set(story.id, session);
    if (!verdict) return false;
    this.notHere.delete(story.id);
    this.leftovers.delete(story.id);
    await ledger.own(story.id, {
      projectId: story.projectId,
      path,
      ...(session ? { session } : {}),
    });
    return true;
  }

  /**
   * Takes on the given stories at work that are this computer's. One found
   * to be another computer's is not asked again while it keeps its session;
   * one that could not be told now is, at the next look. `firstRead`: their
   * project is read for the first time in this run.
   */
  async adoptAll(stories: Iterable<HostStory>, firstRead = false) {
    const checks = hereChecks(true);
    const { ledger } = this.deps;
    const leftover = firstRead && (await ledger.startedEmpty());
    for (const story of stories) {
      if (leftover && atWork(story) && !(await ledger.owns(story.id)))
        this.leftovers.add(story.id);
      if (!atWork(story)) {
        this.notHere.delete(story.id);
        continue;
      }
      if (this.notHere.get(story.id) === (story.engineSessionId ?? ""))
        continue;
      await this.adopt(story, checks);
    }
  }

  // True when this computer runs the story's session (keeps it, for a
  // leftover) or has its own worktree; undefined when that cannot be told
  // now (the VM stopped, or not looked in yet).
  private async here(
    story: HostStory,
    path: string,
    checks: HereChecks,
  ): Promise<boolean | undefined> {
    const { host, within } = this.deps;
    let unknown = false;
    const ask = async (check: () => Promise<boolean>) => {
      try {
        return await within(check(), "This computer");
      } catch {
        unknown = true;
        return false;
      }
    };
    const session = story.engineSessionId;
    const location = storyLocation(story.workspaceMode);
    // In the runtime VM, a look of the service's own waits until it runs.
    const looks =
      location !== "vm" || !checks.background || this.deps.runtimeReady();
    if (session) {
      checks.running ??= host.call("running", undefined);
      if (await ask(async () => (await checks.running!).includes(session)))
        return true;
      if (host.storedSessions && this.leftovers.has(story.id)) {
        if (!looks) unknown = true;
        else {
          if (!checks.stored.has(location))
            checks.stored.set(location, host.storedSessions(location));
          const stored = checks.stored.get(location)!;
          if (await ask(async () => (await stored).includes(session)))
            return true;
        }
      }
    }
    const worktree = story.worktree;
    const worktreeHere = host.desktop.storyWorktreeHere;
    if (worktree && story.workspaceMode !== "direct" && worktreeHere) {
      const input = {
        repositoryRoot: path,
        worktree,
        workspaceMode: story.workspaceMode,
      };
      if (!looks) unknown = true;
      else if (await ask(() => worktreeHere(input))) return true;
    }
    return unknown ? undefined : false;
  }
}
