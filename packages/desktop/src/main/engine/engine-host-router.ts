import type {
  EngineHostEvent,
  EngineHostInput,
  EngineHostMethod,
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
 * API connection and every follow still open.
 */
export class EngineHostRouter {
  private readonly follows = new Map<string, { session: string; viewer: EngineViewer }>();
  private readonly viewers = new Map<number, EngineViewer>();
  private connection: EngineHostInput<"connect"> | undefined;

  /** Notes what a call means for routing; false when the window may not make it. */
  observe<M extends EngineHostMethod>(viewer: EngineViewer, method: M, input: EngineHostInput<M>) {
    if (method === "shutdown") return false;
    this.viewers.set(viewer.id, viewer);
    if (method === "connect") this.connection = input as EngineHostInput<"connect">;
    if (method === "follow") {
      const { session, subscription } = input as EngineHostInput<"follow">;
      this.follows.set(subscription, { session, viewer });
    }
    if (method === "unfollow") this.follows.delete((input as EngineHostInput<"unfollow">).subscription);
    return true;
  }

  route(event: EngineHostEvent) {
    if (event.type === "follow") {
      const follow = this.follows.get(event.subscription);
      if (follow && !follow.viewer.isDestroyed()) follow.viewer.send("engine:event", event);
      return;
    }
    for (const viewer of this.viewers.values())
      if (viewer.isDestroyed()) this.viewers.delete(viewer.id);
      else viewer.send("engine:event", event);
  }

  /** The window closed: what it followed is not needed any more. */
  forget(viewerId: number): string[] {
    this.viewers.delete(viewerId);
    const dropped: string[] = [];
    for (const [subscription, follow] of this.follows)
      if (follow.viewer.id === viewerId) {
        this.follows.delete(subscription);
        dropped.push(subscription);
      }
    return dropped;
  }

  /** What a restarted engine host is told, in order. */
  replay(): Array<{ [M in EngineHostMethod]: { method: M; input: EngineHostInput<M> } }[EngineHostMethod]> {
    return [
      ...(this.connection ? [{ method: "connect" as const, input: this.connection }] : []),
      ...[...this.follows].map(([subscription, { session }]) => ({
        method: "follow" as const,
        input: { session, subscription },
      })),
    ];
  }
}
