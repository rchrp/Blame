import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./light-workspace.js";

test("a six-second command returns its final outcome without status polling", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-initial-wait-"));
  try {
    const workspace = new LightWorkspace(root, { sessionId: "initial-wait" });
    const result = await workspace.runTask({
      kind: "command",
      command: "node -e 'setTimeout(() => process.stdout.write(\"complete\"), 6000)'",
    }, {});
    assert.ok(result.status === "ok", JSON.stringify(result));
    const data = result.data as { exitCode?: number; output?: string; run?: string };
    assert.equal(data.exitCode, 0);
    assert.equal(data.output, "complete");
    assert.equal(data.run, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a final grep that selects nothing says it hid the output, not that nothing was printed", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-final-filter-"));
  try {
    const workspace = new LightWorkspace(root, { sessionId: "final-filter" });
    for (const command of [
      "node -e 'console.log(\"done\")' | grep missing",
      "MODE=test node -e 'console.log(\"a|b\")' 2>&1 | grep -E \"x|y\"",
    ]) {
      const result = await workspace.runTask({ kind: "command", command }, {});
      assert.equal(result.status, "blocked", JSON.stringify(result));
      if (result.status !== "blocked") continue;
      assert.match(result.message, /its last stage, `grep`, selected no line/);
      assert.match(result.recovery ?? "", /without the final filter/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
