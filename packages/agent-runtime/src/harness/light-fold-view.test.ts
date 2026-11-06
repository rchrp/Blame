import assert from "node:assert/strict";
import test from "node:test";
import { parseCode } from "./code-intelligence.js";
import {
  foldBodyMinimumCharacters,
  foldCallCharacters,
  foldFileMinimumCharacters,
} from "./light-fold-economics.js";
import { foldMarkerPattern, lineAlignedWindow, planFold, renderFold, type FoldAttention } from "./light-fold-view.js";

const none: FoldAttention = { lines: new Set(), symbols: new Set() };

function fold(path: string, source: string, attention = none, window?: [number, number]) {
  const content = Buffer.from(source);
  const parsed = parseCode(path, content);
  const range = window ?? [0, content.byteLength];
  const plan = planFold(content, parsed, range, attention);
  const aliases = new Map<string, string>();
  const view = renderFold(content, parsed, range, plan, (symbol) => {
    const key = symbol.qualified_name;
    if (!aliases.has(key)) aliases.set(key, `s${aliases.size + 1}`);
    return aliases.get(key);
  });
  return { content, plan, view };
}

function body(lines: number, prefix = "value") {
  return Array.from({ length: lines }, (_, index) => `  const ${prefix}${index} = compute(${index}, "some longer text");`).join("\n");
}

/** Every line that is not a marker is the file's own line, and shown + hidden bytes tile the window. */
function assertExact(content: Buffer, view: ReturnType<typeof fold>["view"], window: [number, number]) {
  const fileLines = new Set(content.toString("utf8").split("\n"));
  for (const line of view.text.split("\n"))
    if (!foldMarkerPattern.test(line)) assert.ok(fileLines.has(line), `not a file line: ${JSON.stringify(line)}`);
  const pieces = [...view.shown, ...view.markers.map((marker) => marker.hidden)].sort((left, right) => left[0] - right[0]);
  let cursor = window[0];
  for (const [start, end] of pieces) {
    assert.equal(start, cursor);
    cursor = end;
  }
  assert.equal(cursor, window[1]);
}

test("the thresholds follow from the cost model", () => {
  assert.equal(foldCallCharacters, 1236);
  assert.equal(foldBodyMinimumCharacters, 100);
  assert.ok(foldFileMinimumCharacters > 2_000 && foldFileMinimumCharacters < 2_500);
});

test("bodies fold to one marker while signatures, imports and closing lines stay exact", () => {
  const source = [
    'import { compute, render as draw } from "./compute.js";',
    "",
    "export function large(",
    "  first: number,",
    "  second: string,",
    ") {",
    body(8),
    "  return draw(value0);",
    "}",
    "",
    "export function other() {",
    body(8, "other"),
    "}",
    "",
    "export function small() {",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  const { content, plan, view } = fold("a.ts", source);
  assertExact(content, view, [0, content.byteLength]);
  assert.equal(view.markers.length, 2);
  assert.match(view.text, /^ {2}⋯ L7–15 · \d+ · s1 ↗ compute, draw$/mu);
  assert.match(view.text, /^ {2}second: string,$/mu);
  assert.match(view.text, /^export function small\(\) \{\n {2}return 1;\n\}$/mu);
  assert.ok(plan.removed > 0);
});

test("bodies the session pointed at or edited stay whole", () => {
  const source = `export function hit() {\n${body(8)}\n}\n\nexport function edited() {\n${body(8, "other")}\n}\n`;
  const pointed = fold("a.ts", source, { lines: new Set([4]), symbols: new Set(["edited"]) });
  assert.equal(pointed.view.markers.length, 0);
  assert.deepEqual(pointed.plan.kept.map(({ reason }) => reason), ["pointed", "edited"]);
  assert.equal(fold("a.ts", source).view.markers.length, 2);
});

test("small type declarations stay visible", () => {
  const fields = Array.from({ length: 12 }, (_, index) => `  field${index}: string;`).join("\n");
  const { view } = fold("a.ts", `export interface Shape {\n${fields}\n}\n`);
  assert.equal(view.markers.length, 0);
});

test("a dominant test suite folds its test cases, not the whole suite", () => {
  const cases = Array.from({ length: 4 }, (_, index) =>
    `  it("case ${index}", () => {\n${body(5, `case${index}_`).replace(/^/gmu, "  ")}\n  });`).join("\n\n");
  const source = `import { it, describe } from "node:test";\n\ndescribe("suite", () => {\n${cases}\n});\n`;
  const { content, view } = fold("a.test.ts", source);
  assertExact(content, view, [0, content.byteLength]);
  assert.equal(view.markers.length, 4);
  assert.match(view.text, /^ {2}it\("case 2", \(\) => \{$/mu);
});

test("class members fold one by one", () => {
  const methods = Array.from({ length: 3 }, (_, index) =>
    `  method${index}() {\n${body(4, `m${index}_`).replace(/^/gmu, "  ")}\n  }`).join("\n\n");
  const source = `export class Service {\n  private ready = false;\n\n${methods}\n}\n`;
  const { content, view } = fold("a.ts", source);
  assertExact(content, view, [0, content.byteLength]);
  assert.equal(view.markers.length, 3);
  assert.match(view.text, /^ {2}private ready = false;$/mu);
  assert.match(view.text, /^ {4}⋯ L\d+–\d+ · \d+ · s\d+$/mu);
});

test("Python bodies fold below their header line", () => {
  const lines = Array.from({ length: 6 }, (_, index) => `    value${index} = compute(${index}, "some longer text")`).join("\n");
  const source = `from tools import compute\n\ndef run(path):\n${lines}\n    return value0\n\ndef other(path):\n${lines}\n    return value1\n`;
  const { content, view } = fold("a.py", source);
  assertExact(content, view, [0, content.byteLength]);
  assert.match(view.text, /^def run\(path\):\n {4}⋯ L4–10 · \d+ · s1 ↗ compute$/mu);
});

test("a symbol window folds that symbol's members", () => {
  const methods = Array.from({ length: 3 }, (_, index) =>
    `  method${index}() {\n${body(4, `m${index}_`).replace(/^/gmu, "  ")}\n  }`).join("\n\n");
  const source = `const before = 1;\n\nexport class Service {\n${methods}\n}\n\nconst after = 2;\n`;
  const content = Buffer.from(source);
  const symbol = parseCode("a.ts", content).symbols.find(({ name }) => name === "Service")!;
  const window = lineAlignedWindow(content, symbol.range_utf8_bytes);
  const { view } = fold("a.ts", source, none, window);
  assertExact(content, view, window);
  assert.doesNotMatch(view.text, /before|after/u);
  assert.equal(view.markers.length, 3);
});

test("a view over budget lists one line per member", () => {
  const methods = Array.from({ length: 450 }, (_, index) =>
    `  // Method ${index} documentation.\n  method${index}(input: string) {\n${body(3, `m${index}_`).replace(/^/gmu, "  ")}\n  }`).join("\n");
  const { content, view } = fold("a.ts", `export class Large {\n${methods}\n}\n`);
  assert.ok(view.text.length <= 32_000, String(view.text.length));
  assert.match(view.text, /^ {2}method12\(input: string\) \{ ⋯ L\d+–\d+ · \d+ · s\d+$/mu);
  assertExact(content, view, [0, content.byteLength]);
});

test("members too many for one line each are listed in runs", () => {
  const methods = Array.from({ length: 900 }, (_, index) =>
    `  // Method ${index} documentation.\n  method${index}(input: string) {\n${body(2, `m${index}_`).replace(/^/gmu, "  ")}\n  }`).join("\n");
  const source = `export class Huge {\n${methods}\n}\n`;
  const { content, view } = fold("a.ts", source);
  assert.ok(view.text.length <= 32_000, String(view.text.length));
  assert.match(view.text, /^export class Huge \{$/mu);
  assert.match(view.text, /^ {2}\d+ members: method\d+, method\d+, method\d+, … ⋯ L\d+–\d+ · [\d.]+k?$/mu);
  assert.doesNotMatch(view.text, /documentation/u);
  assertExact(content, view, [0, content.byteLength]);
});
