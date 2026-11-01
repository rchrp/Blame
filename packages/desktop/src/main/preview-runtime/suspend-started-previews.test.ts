import assert from "node:assert/strict";
import test from "node:test";
import { suspendStartedPreviews } from "./suspend-started-previews.ts";

test("suspends the started cloud previews on quit, not a working agent", async () => {
  const sessions: Record<string, { host: string; agent: string }> = {
    web: { host: "running", agent: "idle" },
    agent: { host: "running", agent: "running" },
    asleep: { host: "suspended", agent: "idle" },
    gone: { host: "running", agent: "idle" },
  };
  const suspended: string[] = [];
  await suspendStartedPreviews(
    {
      get: async (id) => {
        if (id === "gone") throw new Error("Network unavailable");
        return { id, state: sessions[id] } as never;
      },
      command: async (id, command) => {
        assert.equal(command.type, "suspend-host");
        suspended.push(id);
        return { id } as never;
      },
    },
    Object.keys(sessions),
  );
  assert.deepEqual(suspended, ["web"]);
});
