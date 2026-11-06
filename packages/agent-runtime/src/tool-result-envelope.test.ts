import assert from "node:assert/strict";
import test from "node:test";
import { encodeToolResult, feedbackEnvelope, unwrapFeedbackEnvelope } from "./tool-result-envelope.js";

type Part = { type: string; text?: string };

test("multi-line text fields read as fenced sections after one metadata line, and decode losslessly", () => {
  const source = 'pattern = r"\\d+\\.é"\npath = "C:\\\\tools"\r\n```js\nconst fence = "````";\n```\n';
  const result = { status: "ok", data: { path: "a.py", content: source, lines: [1, 6],
    segments: [{ lines: [1, 1], content: "first\n" }, { lines: [9, 9], content: "plain" }],
    reporting: { outcome: "failed", admission: "unverified" } } };
  const before = structuredClone(result);
  const encoded = encodeToolResult(result) as Part[];
  assert.deepEqual(result, before);
  assert.equal(encoded.length, 3);
  const header = JSON.parse(encoded[0]!.text!);
  assert.equal(header.format, "blame_tool_result_v2");
  assert.deepEqual(header.sections, [["data", "content"], ["data", "segments", 0, "content"]]);
  assert.equal(header.result.data.content, "[see data.content]");
  assert.equal(header.result.data.segments[1].content, "plain", "Text JSON need not escape stays inline.");
  assert.equal(encoded[1]!.text, `data.content:\n\`\`\`\`\`\n${source}\n\`\`\`\`\``);
  assert.equal(encoded[2]!.text, "data.segments[0].content:\n```\nfirst\n\n```");
  assert.deepEqual(unwrapFeedbackEnvelope(encoded), result);
});

test("hash-only fields are dropped; results without long text stay one object", () => {
  const result = { status: "ok", data: { changed: true, sourceRevisionId: `src_${"a".repeat(32)}`,
    checks: [{ id: `validation://${"b".repeat(64)}`, command: "pnpm test" }],
    scope: { forwardedArgsSha256: "c".repeat(64), digest: `sha256:${"d".repeat(64)}`, changedTestCount: 1 },
    receipt: "command-src_1" } };
  assert.deepEqual(encodeToolResult(result), { status: "ok", data: { changed: true,
    checks: [{ command: "pnpm test" }], scope: { changedTestCount: 1 }, receipt: "command-src_1" } });
});

test("images follow the text parts and are not part of the decoded result", () => {
  const image = { type: "image", mediaType: "image/png", data: "aW1hZ2U=" };
  const plain = encodeToolResult({ status: "ok", data: { path: "pixel.png" } }, [image]) as Part[];
  assert.deepEqual(plain.slice(1), [image]);
  assert.deepEqual(unwrapFeedbackEnvelope(plain), { status: "ok", data: { path: "pixel.png" } });
  const sectioned = encodeToolResult({ status: "ok", data: { note: "a\nb" }, message: "x\ny" }, [image]) as Part[];
  assert.deepEqual(sectioned.at(-1), image);
  assert.deepEqual(unwrapFeedbackEnvelope(sectioned), { status: "ok", data: { note: "a\nb" }, message: "x\ny" });
});

test("earlier v1 envelopes still decode", () => {
  const output = "diagnostic\n".repeat(100);
  const v1 = [
    { type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: { status: "ok", data: { output: null, exitCode: 1 } }, textFields: [["data", "output"]] }) },
    { type: "text", text: output },
  ];
  assert.deepEqual(unwrapFeedbackEnvelope(v1), { status: "ok", data: { output, exitCode: 1 } });
  const nested = { status: "ok", data: { output: "diagnostic\n".repeat(1_600), diagnostics: [{ content: "const a = 'q';\n".repeat(100) }] } };
  assert.deepEqual(unwrapFeedbackEnvelope(feedbackEnvelope(nested)), nested);
});

test("Cline's middle cut of a section keeps the result decodable", () => {
  const output = "line\n".repeat(30_000);
  const encoded = encodeToolResult({ status: "ok", data: { output, exitCode: 0 } }) as Part[];
  const text = encoded[1]!.text!;
  const cut = [encoded[0]!, { type: "text", text: `${text.slice(0, 1_000)}\n...[truncated]...\n${text.slice(-1_000)}` }];
  const decoded = unwrapFeedbackEnvelope(cut) as { data: { output: string; exitCode: number } };
  assert.equal(decoded.data.exitCode, 0);
  assert.match(decoded.data.output, /truncated/u);
});

test("foreign arrays, JSON inside source, and malformed envelopes are returned unchanged", () => {
  const result = { status: "ok", data: { output: "done" } };
  assert.equal(unwrapFeedbackEnvelope(result), result);
  assert.equal(unwrapFeedbackEnvelope(undefined), undefined);
  const header = (result: unknown, sections: unknown) => ({ type: "text", text: JSON.stringify({ format: "blame_tool_result_v2", result, sections }) });
  const section = "data.output:\n```\na\nb\n```";
  for (const value of [
    [{ type: "text", text: JSON.stringify(result) }],
    [{ type: "text", text: JSON.stringify(result) }, { type: "image", mediaType: "image/png", data: "eA==" }],
    [{ type: "text", text: '{"format":"blame_tool_result_v2"' }],
    [header({ data: { output: "[see data.output]" } }, [["data", "output"]])],
    [header({ data: { output: "[see data.output]" } }, [["data", "output"]]), { type: "text", text: "data.output:\na\nb" }],
    [header({ data: { output: "real value" } }, [["data", "output"]]), { type: "text", text: section }],
    [header({ data: { output: "[see data.output]" } }, [["data", "output"]]), { type: "text", text: section }, { type: "text", text: "extra" }],
    [header({ data: {} }, [["__proto__", "polluted"]]), { type: "text", text: "__proto__.polluted:\n```\nx\n```" }],
    [header({ data: [] }, [["data", 0]]), { type: "text", text: "data[0]:\n```\nx\n```" }],
    [{ type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: {}, textFields: [["missing"]] }) }],
    [{ type: "text", text: JSON.stringify({ format: "blame_tool_result_v1", result: {}, textFields: [["__proto__", "polluted"]] }) }, { type: "text", text: "x" }],
  ]) assert.equal(unwrapFeedbackEnvelope(value), value);
  assert.equal(Object.hasOwn({}, "polluted"), false);
  assert.deepEqual(unwrapFeedbackEnvelope([header({ data: { output: "[see data.output]" } }, [["data", "output"]]), { type: "text", text: section }]),
    { data: { output: "a\nb" } });
});
