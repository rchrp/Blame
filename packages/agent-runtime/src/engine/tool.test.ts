import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolHostContext } from "@blame/engine-client";
import { ToolSet, defineTool } from "./tool.js";

const call = { session: "s", turn: "t", call: "c", input: {} };

function context(signal = new AbortController().signal) {
  const progress: string[] = [];
  const host: ToolHostContext = {
    signal,
    id: 1,
    progress: (text) => progress.push(text),
  };
  return { host, progress };
}

const echo = defineTool<{ say?: string }>({
  name: "echo",
  description: "Says it back.",
  inputSchema: { type: "object", properties: { say: { type: "string" } } },
  effect: "read_only",
  run: ({ say }, { progress }) => {
    progress("echoing");
    return say ?? "";
  },
});

describe("client tools", () => {
  it("describe themselves as the engine's tool specs", () => {
    const set = new ToolSet([
      echo,
      {
        ...echo,
        name: "write",
        effect: "workspace_write",
        needsApproval: true,
      },
    ]);
    assert.deepEqual(set.specs(["write"]), [
      {
        name: "write",
        description: "Says it back.",
        input_schema: echo.inputSchema,
        effect: "workspace_write",
        ends_turn: false,
        needs_approval: true,
      },
    ]);
    assert.throws(() => set.specs(["missing"]), /no client tool named missing/);
    assert.throws(() => new ToolSet([echo, echo]), /Two client tools/);
  });

  it("run with progress and answer what the model reads", async () => {
    const set = new ToolSet([
      echo,
      defineTool({
        name: "json",
        description: "",
        inputSchema: {},
        effect: "read_only",
        run: () => ({ json: { a: 1 } }),
      }),
      defineTool({
        name: "refuse",
        description: "",
        inputSchema: {},
        effect: "read_only",
        run: () => ({ ok: false, content: [{ type: "text", text: "no" }] }),
      }),
      defineTool({
        name: "throw",
        description: "",
        inputSchema: {},
        effect: "read_only",
        run: () => {
          throw new Error("broke");
        },
      }),
    ]);
    const { host, progress } = context();
    assert.deepEqual(
      await set.handle({ ...call, name: "echo", input: { say: "hi" } }, host),
      {
        outcome: "completed",
        content: [{ type: "text", text: "hi" }],
      },
    );
    assert.deepEqual(progress, ["echoing"]);
    assert.deepEqual(await set.handle({ ...call, name: "json" }, host), {
      outcome: "completed",
      content: [{ type: "text", text: '{"a":1}' }],
    });
    assert.equal(
      (await set.handle({ ...call, name: "refuse" }, host)).outcome,
      "failed",
    );
    assert.deepEqual(await set.handle({ ...call, name: "throw" }, host), {
      outcome: "failed",
      content: [{ type: "text", text: "broke" }],
    });
    assert.equal(
      (await set.handle({ ...call, name: "nope" }, host)).outcome,
      "failed",
    );
    assert.equal(
      (await set.handle({ ...call, name: "echo", input: [] as never }, host))
        .outcome,
      "failed",
    );
  });

  it("stop when the engine withdraws the call, even if the tool does not listen", async () => {
    const set = new ToolSet([
      defineTool({
        name: "slow",
        description: "",
        inputSchema: {},
        effect: "read_only",
        run: () => new Promise<string>(() => {}),
      }),
      defineTool({
        name: "late",
        description: "",
        inputSchema: {},
        effect: "read_only",
        timeoutMs: 20,
        run: () => new Promise<string>(() => {}),
      }),
    ]);
    const controller = new AbortController();
    const pending = set.handle(
      { ...call, name: "slow" },
      context(controller.signal).host,
    );
    controller.abort();
    assert.equal((await pending).outcome, "cancelled");
    const timedOut = await set.handle(
      { ...call, name: "late" },
      context().host,
    );
    assert.equal(timedOut.outcome, "failed");
    assert.match(JSON.stringify(timedOut.content), /longer than 20 ms/);
  });
});
