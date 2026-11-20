import assert from "node:assert/strict";
import { it } from "node:test";
import type { EngineHostEvent } from "@blame/agent-runtime/engine-protocol";
import { EngineHostRouter, type EngineViewer } from "./engine-host-router.ts";

function viewer(id: number) {
  const received: EngineHostEvent[] = [];
  let destroyed = false;
  const value: EngineViewer & { received: EngineHostEvent[]; destroy(): void } = {
    id,
    received,
    isDestroyed: () => destroyed,
    send: (_channel, event) => received.push(event),
    destroy: () => (destroyed = true),
  };
  return value;
}

const records = (subscription: string): EngineHostEvent => ({
  type: "follow",
  subscription,
  event: { type: "records", records: [] },
});

it("sends a session's events to the window that follows it, activity to all", () => {
  const router = new EngineHostRouter();
  const one = viewer(1);
  const two = viewer(2);
  router.observe(one, "follow", { session: "s", subscription: "a" });
  router.observe(two, "connect", { api: null });
  router.route(records("a"));
  router.route(records("b"));
  router.route({ type: "activity", session: "s", running: true });
  assert.equal(one.received.length, 2);
  assert.deepEqual(two.received, [{ type: "activity", session: "s", running: true }]);
  router.observe(one, "unfollow", { subscription: "a" });
  router.route(records("a"));
  assert.equal(one.received.length, 2);
});

it("refuses shutdown from a window and forgets a closed window's follows", () => {
  const router = new EngineHostRouter();
  const one = viewer(1);
  assert.equal(router.observe(one, "shutdown", undefined), false);
  router.observe(one, "follow", { session: "s", subscription: "a" });
  router.observe(one, "follow", { session: "t", subscription: "b" });
  assert.deepEqual(router.forget(1).sort(), ["a", "b"]);
  assert.deepEqual(router.replay(), []);
});

it("tells a restarted host the connection, then every open follow", () => {
  const router = new EngineHostRouter();
  const one = viewer(1);
  router.observe(one, "follow", { session: "s", subscription: "a" });
  router.observe(one, "connect", { api: { url: "http://api", token: "t" } });
  assert.deepEqual(router.replay(), [
    { method: "connect", input: { api: { url: "http://api", token: "t" } } },
    { method: "follow", input: { session: "s", subscription: "a" } },
  ]);
});
