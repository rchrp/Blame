import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, Message, ToolResultContent } from "@cline/sdk";
import { presentToolResults } from "./tool-result-presentation.js";
import { encodeToolResult, unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

test("source text reaches the provider with original quotes, slashes, and Unicode", () => {
  const source = 'pattern = r"\\d+\\.é"\npath = "C:\\\\tools"\r\n';
  const result = { status: "ok", data: { path: "source.py", content: source, lines: [1, 2], complete: true, editTargets: [{ alias: "s1" }] } };
  const history = messages("read_code", result);
  const original = structuredClone(history);
  const projected = presentToolResults(history);
  const output = text(projected);
  assert.ok(output.includes(source));
  assert.equal(output.includes(JSON.stringify(source)), false);
  assert.deepEqual(header(projected).result, { status: "ok", data: { path: "source.py", content: "[see data.content]", lines: [1, 2], complete: true, editTargets: [{ alias: "s1" }] } });
  assert.deepEqual(unwrapFeedbackEnvelope(parts(projected)), result);
  assert.deepEqual(history, original);
  assert.deepEqual(presentToolResults(projected), projected);
});

test("results already in the model-facing form are left as they are", () => {
  const result = { status: "ok", data: { path: "a.ts", content: "line\n".repeat(20_000) } };
  const history = messages("read_code", result);
  const block = (history[1]!.content as ToolResultContent[])[0]!;
  block.content = encodeToolResult(result) as never;
  const projected = presentToolResults(history);
  assert.equal((projected[1]!.content as ContentBlock[])[0], (history[1]!.content as ContentBlock[])[0]);
});

test("command failures retain their status and display exact diagnostics", () => {
  const message = "Patch context does not match.\nExpected: r'\\d+'\n";
  const history = messages("edit_code", { status: "blocked", category: "input", message, recovery: "Read the current target.", diagnosticId: "edit-1" });
  const projected = presentToolResults(history);
  assert.ok(text(projected).includes(`message:\n\`\`\`\n${message}\n\`\`\``));
  assert.deepEqual(header(projected).result, { status: "blocked", category: "input", message: "[see message]", recovery: "Read the current target.", diagnosticId: "edit-1" });
});

test("multisegment reads retain their boundaries and metadata", () => {
  const data = { path: "component.ts", segments: [{ lines: [1, 2], content: "import x;\n" }, { lines: [8, 9], content: "return x;\n" }] };
  const projected = presentToolResults(messages("read_code", { status: "ok", data }));
  const output = text(projected);
  assert.ok(output.includes("data.segments[0].content:\n```\nimport x;\n"));
  assert.ok(output.includes("data.segments[1].content:\n```\nreturn x;\n"));
  assert.deepEqual(header(projected).result.data.segments, [
    { lines: [1, 2], content: "[see data.segments[0].content]" },
    { lines: [8, 9], content: "[see data.segments[1].content]" },
  ]);
});

test("source containing Markdown fences remains within a longer fence", () => {
  const source = '```js\nconst text = "````";\n```';
  const output = text(presentToolResults(messages("read_code", { status: "ok", data: { content: source } })));
  assert.ok(output.endsWith(`data.content:\n\`\`\`\`\`\n${source}\n\`\`\`\`\``));
});

test("native tools, malformed results, simple text, and foreign images remain unchanged", () => {
  const image = messages("read_code", { status: "ok" });
  const block = (image[1]!.content as ToolResultContent[])[0]!;
  block.content = [{ type: "text", text: "image metadata" }, { type: "image", mediaType: "image/png", data: "aW1hZ2U=" }];
  for (const history of [messages("read_file", { status: "ok", data: { content: "line\n" } }), messages("read_code", "not JSON"), messages("read_code", { status: "ok", data: { content: "plain" } }), image])
    assert.deepEqual(presentToolResults(history), history);
});

test("long harness results reach the model whole, in one section rather than 8,000-character blocks", () => {
  const source = `${Array.from({ length: 900 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`;
  const result = { status: "ok", data: { path: "values.ts", view: "raw", content: source, lines: [1, 900], complete: true } };
  const projected = presentToolResults(messages("read_code", result));
  const blocks = parts(projected);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1]!.text, `data.content:\n\`\`\`\n${source}\n\`\`\``);
  assert.deepEqual(presentToolResults(projected), projected);
});

test("images stay after the text parts", () => {
  const image = { type: "image", mediaType: "image/png", data: "aW1hZ2U=" };
  const history = messages("read_code", {});
  const block = (history[1]!.content as ToolResultContent[])[0]!;
  block.content = [
    { type: "text", text: JSON.stringify({ format: "blame_tool_result_v2", result: { status: "ok", data: { path: "a.png", sourceRevisionId: `src_${"a".repeat(32)}`, recovery: "r".repeat(90) } }, sections: [] }) },
    image,
  ] as never;
  const projected = parts(presentToolResults(history));
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[1], image);
  assert.deepEqual(unwrapFeedbackEnvelope(projected), { status: "ok", data: { path: "a.png", recovery: "r".repeat(90) } });
});

test("the model reads no hash-only fields and long advice only once", () => {
  const advice = "These invocation results do not apply to this source snapshot. After the final source/test edit, rerun every required invocation.";
  const edit = (id: string) => ({
    status: "ok",
    data: {
      changed: true,
      sourceRevisionId: `src_${"a".repeat(32)}`,
      validationState: {
        invalidatedChecks: [{ id: `validation://${"b".repeat(64)}`, command: "pnpm test", previousOutcome: "passed" }],
        guidance: advice,
      },
      testValidationScope: { forwardedArgsSha256: "c".repeat(64), changedTestCount: 1 },
      receipt: id,
    },
  });
  const history: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "one", name: "edit_code", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: JSON.stringify(edit("c1")) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "two", name: "edit_code", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "two", content: JSON.stringify(edit("c2")) }] },
  ];
  const projected = presentToolResults(history);
  const result = (index: number) => JSON.parse(((projected[index]!.content as ContentBlock[])[0] as ToolResultContent).content as string);
  const first = result(1), second = result(3);
  assert.equal(first.data.sourceRevisionId, undefined);
  assert.deepEqual(first.data.validationState.invalidatedChecks, [{ command: "pnpm test", previousOutcome: "passed" }]);
  assert.deepEqual(first.data.testValidationScope, { changedTestCount: 1 });
  assert.equal(first.data.validationState.guidance, advice);
  assert.equal(second.data.validationState.guidance, undefined, "Advice already read is not repeated.");
  assert.equal(second.data.receipt, "c2");
  assert.deepEqual(presentToolResults(projected), projected);
});

test("long advice already read is dropped from a multipart result too", () => {
  const advice = "Rerun every required invocation after the final source edit; earlier results do not apply to this snapshot.";
  const result = (output: string) => encodeToolResult({ status: "ok", data: { output, guidance: advice } });
  const history: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "one", name: "run_task", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: result("first\nrun") as never }] },
    { role: "assistant", content: [{ type: "tool_use", id: "two", name: "run_task", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "two", content: result("second\nrun") as never }] },
  ];
  const projected = presentToolResults(history);
  const decoded = (index: number) => unwrapFeedbackEnvelope(((projected[index]!.content as ContentBlock[])[0] as ToolResultContent).content) as { data: Record<string, unknown> };
  assert.equal(decoded(1).data.guidance, advice);
  assert.deepEqual(decoded(3).data, { output: "second\nrun" });
});

test("run_task's earlier v1 envelope is presented in the current form", () => {
  const output = `${"failing line\n".repeat(1_000)}`;
  const envelope = [
    { type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: { status: "blocked", category: "code", message: null }, textFields: [["message"]] }) },
    { type: "text", text: output },
  ];
  const history: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "run_task", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: envelope as never }] },
  ];
  const projected = presentToolResults(history);
  assert.deepEqual(header(projected).result, { status: "blocked", category: "code", message: "[see message]" });
  assert.equal(parts(projected)[1]!.text, `message:\n\`\`\`\n${output}\n\`\`\``);
});

function messages(name: string, result: unknown): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "call", name, input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: typeof result === "string" ? result : JSON.stringify(result) }] },
  ];
}

function parts(messages: Message[]) {
  const block = (messages[1]!.content as ContentBlock[])[0]!;
  assert.equal(block.type, "tool_result");
  const content = (block as ToolResultContent).content;
  assert.ok(Array.isArray(content));
  return content as Array<{ type: string; text?: string }>;
}

function header(messages: Message[]) {
  return JSON.parse(parts(messages)[0]!.text!);
}

function text(messages: Message[]) {
  return parts(messages).map((part) => part.text ?? "").join("\n\n");
}
