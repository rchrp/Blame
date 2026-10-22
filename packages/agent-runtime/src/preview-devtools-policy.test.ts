import assert from "node:assert/strict";
import test from "node:test";
import {
  previewDevtoolsAgentTimeoutMs,
  previewDevtoolsBoundedArguments,
  previewDevtoolsMaxTimeoutMs,
  previewDevtoolsToolTimeoutMs,
} from "./preview-devtools-policy.js";

test("ordinary and slow tools keep their base timeouts", () => {
  assert.equal(previewDevtoolsToolTimeoutMs("click"), 15_000);
  assert.equal(previewDevtoolsToolTimeoutMs("lighthouse_audit"), 120_000);
  // The browser's default waits fit inside the base timeout.
  assert.equal(previewDevtoolsToolTimeoutMs("wait_for"), 15_000);
  assert.equal(previewDevtoolsToolTimeoutMs("navigate_page"), 15_000);
});

test("a longer wait asked by the agent extends the call", () => {
  assert.equal(
    previewDevtoolsToolTimeoutMs("wait_for", {
      arguments: { timeout: 30_000 },
    }),
    35_000,
  );
  assert.equal(
    previewDevtoolsToolTimeoutMs("navigate_page", {
      arguments: { type: "url", url: "/", timeout: 60_000 },
    }),
    65_000,
  );
  // 0 means the browser's default.
  assert.equal(
    previewDevtoolsToolTimeoutMs("wait_for", { arguments: { timeout: 0 } }),
    15_000,
  );
  // Other tools ignore a timeout argument.
  assert.equal(
    previewDevtoolsToolTimeoutMs("click", { arguments: { timeout: 60_000 } }),
    15_000,
  );
});

test("emulated CPU and network slowdown stretch every call", () => {
  assert.equal(
    previewDevtoolsToolTimeoutMs("click", {
      slowdown: { cpuThrottlingRate: 4 },
    }),
    60_000,
  );
  assert.equal(
    previewDevtoolsToolTimeoutMs("take_snapshot", {
      slowdown: { networkConditions: "Slow 4G" },
    }),
    37_500,
  );
  // Unknown or invalid values count as no slowdown.
  assert.equal(
    previewDevtoolsToolTimeoutMs("click", {
      slowdown: { cpuThrottlingRate: "fast", networkConditions: "Offline" },
    }),
    15_000,
  );
});

test("no call goes past the ceiling, and the agent waits beyond it", () => {
  assert.equal(
    previewDevtoolsToolTimeoutMs("navigate_page", {
      slowdown: { cpuThrottlingRate: 20, networkConditions: "Slow 3G" },
    }),
    previewDevtoolsMaxTimeoutMs,
  );
  assert.equal(
    previewDevtoolsToolTimeoutMs("wait_for", {
      arguments: { timeout: 3_600_000 },
    }),
    previewDevtoolsMaxTimeoutMs,
  );
  assert.ok(previewDevtoolsAgentTimeoutMs() > previewDevtoolsMaxTimeoutMs);
});

test("a wait past the ceiling is shortened so the browser gives up first", () => {
  assert.deepEqual(
    previewDevtoolsBoundedArguments("wait_for", {
      text: ["Saved"],
      timeout: 3_600_000,
    }),
    { text: ["Saved"], timeout: previewDevtoolsMaxTimeoutMs - 5_000 },
  );
  const short = { text: ["Saved"], timeout: 2_000 };
  assert.equal(previewDevtoolsBoundedArguments("wait_for", short), short);
  const click = { uid: "1_2", timeout: 3_600_000 };
  assert.equal(previewDevtoolsBoundedArguments("click", click), click);
});
