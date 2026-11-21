import {
  engineMainOnlyMethods,
  engineStoryMainOnlyMethods,
  type EngineHostEvent,
  type EngineHostInput,
  type EngineHostMethod,
  type EngineSessionSettings,
} from "@blame/agent-runtime/engine-protocol";

/** A window that talks to the engine (a WebContents, in the app). */
export type EngineViewer = {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, event: EngineHostEvent): void;
};

/**
 * Which window gets which event: a session's records go to the windows that
 * follow it, a turn starting or ending to every window. It also remembers
 * what a new engine host must be told again after the last one died: the
 * API connection, the story service's projects and settings (so stories
 * are recovered and the queue runs again), and every follow still open.
 */
export class EngineHostRouter {
  private readonly follows = new Map<
    string,
    { session: string; viewer: EngineViewer }
  >();
  private readonly viewers = new Map<number, EngineViewer>();
  private connection: EngineHostInput<"connect"> | undefined;
  // The projects and settings each open window gave the story service, the
  // latest last: a restarted host is told what every open window knows,
  // and the latest settings win there too.
  private readonly storySyncs = new Map<number, EngineHostInput<"storySync">>();
  // Where each session works, from the settings its calls carry, and which
  // sessions have a turn running: the rest of the app keeps a preview up and
  // does not merge into a folder an agent is writing.
  private readonly workspaces = new Map<string, string>();
  private readonly running = new Set<string>();

  /** Notes what a call means for routing; false when the window may not make it. */
  observe<M extends EngineHostMethod>(
    viewer: EngineViewer,
    method: M,
    input: EngineHostInput<M>,
  ) {
    if (
      method === "shutdown" ||
      (engineMainOnlyMethods as readonly string[]).includes(method) ||
      (engineStoryMainOnlyMethods as readonly string[]).includes(method)
    )
      return false;
    this.viewers.set(viewer.id, viewer);
    if (method === "connect") {
      const next = input as EngineHostInput<"connect">;
      // Signed out, or another API: what the windows knew is not told again.
      if (!next.api || next.api.url !== this.connection?.api?.url)
        this.storySyncs.clear();
      this.connection = next;
    }
    if (method === "storySync") {
      this.storySyncs.delete(viewer.id);
      this.storySyncs.set(viewer.id, input as EngineHostInput<"storySync">);
    }
    if (method === "follow") {
      const { session, subscription } = input as EngineHostInput<"follow">;
      this.follows.set(subscription, { session, viewer });
    }
    if (method === "unfollow")
      this.follows.delete((input as EngineHostInput<"unfollow">).subscription);
    if (method === "createSession" || method === "configure" || method === "send") {
      const call = input as { session: string; settings?: unknown } & Partial<EngineSessionSettings>;
      const settings = (method === "send" ? call.settings : call) as EngineSessionSettings | undefined;
      const root = settings ? sessionWorkspace(settings) : undefined;
      if (root) this.workspaces.set(call.session, root);
    }
    return true;
  }

  hostStopped() {
    this.running.clear();
  }

  /** The folders a running engine turn is writing in. */
  activeWorkspaces(): string[] {
    return [...this.running].flatMap((session) => {
      const root = this.workspaces.get(session);
      return root ? [root] : [];
    });
  }

  route(event: EngineHostEvent) {
    if (event.type === "activity") {
      // The host names the folder of a session it started itself (a story).
      if (event.workspace) this.workspaces.set(event.session, event.workspace);
      if (event.running) this.running.add(event.session);
      else this.running.delete(event.session);
    }
    if (event.type === "follow") {
      const follow = this.follows.get(event.subscription);
      if (follow && !follow.viewer.isDestroyed())
        follow.viewer.send("engine:event", event);
      return;
    }
    for (const viewer of this.viewers.values())
      if (viewer.isDestroyed()) this.viewers.delete(viewer.id);
      else viewer.send("engine:event", event);
  }

  /** The window closed: what it followed is not needed any more. */
  forget(viewerId: number): string[] {
    this.viewers.delete(viewerId);
    this.storySyncs.delete(viewerId);
    const dropped: string[] = [];
    for (const [subscription, follow] of this.follows)
      if (follow.viewer.id === viewerId) {
        this.follows.delete(subscription);
        dropped.push(subscription);
      }
    return dropped;
  }

  /** The story service's id of a window, to tell the host it closed. */
  storyWindow(viewerId: number) {
    return this.storySyncs.get(viewerId)?.window;
  }

  /** What a restarted engine host is told, in order. */
  replay(): Array<
    {
      [M in EngineHostMethod]: { method: M; input: EngineHostInput<M> };
    }[EngineHostMethod]
  > {
    return [
      ...(this.connection
        ? [{ method: "connect" as const, input: this.connection }]
        : []),
      ...[...this.storySyncs.values()].map((input) => ({
        method: "storySync" as const,
        input,
      })),
      ...[...this.follows].map(([subscription, { session }]) => ({
        method: "follow" as const,
        input: { session, subscription },
      })),
    ];
  }
}

function sessionWorkspace(settings: EngineSessionSettings) {
  switch (settings.purpose) {
    case "quick-chat":
      return settings.settings.workspaceRoot;
    case "development-story":
    case "plan":
      return settings.settings.workspace.root;
    default:
      // The new-project assistant works in a scratch folder of its own.
      return undefined;
  }
}
