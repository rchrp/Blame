// Runs the client against the real binary, when it has been built:
//   cargo build -p blame-engine      (then target/debug/blame-engine exists)
// or with BLAME_ENGINE_BIN pointing at one. Without it the tests are skipped,
// so the package's tests need no Rust toolchain.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EngineClient } from "./client.js";
import { followSession, type FollowEvent } from "./follow.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { EngineSupervisor } from "./supervisor.js";
import { scratchDirectory, sessionConfig, waitFor } from "./test-support.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ??
  join(repositoryRoot, "target", "debug", "blame-engine");
const available = existsSync(binary);

const options = {
  clientName: "engine-client-test",
  clientVersion: "0",
  shutdownTimeoutMs: 10_000,
};

describe(
  "the real blame-engine",
  {
    skip: available
      ? false
      : `no ${binary}: build it with cargo build -p blame-engine`,
  },
  () => {
    it("answers initialize with the protocol version this client speaks, and shuts down cleanly", async () => {
      const data = scratchDirectory();
      try {
        const client = await EngineClient.start(
          { command: binary, args: ["serve", "--data-dir", data.path] },
          options,
        );
        assert.equal(client.info.protocol_version, PROTOCOL_VERSION);
        assert.ok(client.info.engine_version.length > 0);
        const exit = await client.shutdown();
        assert.equal(exit.expected, true);
        assert.equal(exit.code, 0);
      } finally {
        data.remove();
      }
    });

    it("keeps a session across restarts and a follower resumes it without repeating a record", async () => {
      const data = scratchDirectory();
      const engine = new EngineSupervisor(() =>
        EngineClient.start(
          { command: binary, args: ["serve", "--data-dir", data.path] },
          options,
        ),
      );
      try {
        const client = await engine.client();
        await client.createSession({ session: "real", config: sessionConfig });
        const events: FollowEvent[] = [];
        const follower = followSession({
          source: engine,
          session: "real",
          onEvent: (event) => events.push(event),
          retryDelayMs: () => 20,
        });
        const seqs = () =>
          events.flatMap((e) =>
            e.type === "records" ? e.records.map((r) => r.seq) : [],
          );
        await waitFor(() => seqs().length >= 1, "the first record");
        assert.deepEqual(seqs(), [1]);

        client.kill();
        await client.closed;
        const second = await engine.client();
        assert.notEqual(second, client);
        await waitFor(
          () => events.filter((e) => e.type === "attached").length >= 2,
          "the follower to reattach",
        );
        assert.deepEqual(seqs(), [1]);
        const listed = await second.listSessions();
        assert.deepEqual(
          listed.sessions.map((s) => s.session),
          ["real"],
        );
        await follower.stop();
      } finally {
        await engine.stop();
        data.remove();
      }
    });
  },
);
