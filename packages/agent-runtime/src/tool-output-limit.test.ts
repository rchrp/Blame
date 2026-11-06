import assert from "node:assert/strict";
import test from "node:test";
import { limitText, limitToolText } from "./tool-output-limit.js";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

test("text within its limit is returned as it is", () => {
  const output = { content: [{ type: "text", text: "short" }] };
  assert.equal(limitText("short", { characters: 10 }), "short");
  assert.equal(limitToolText(output, { characters: 10 }), output);
});

test("a head cut keeps whole lines and says how to get more", () => {
  const text = lines(1_000);
  const limited = limitText(text, {
    characters: 1_000,
    more: "Page with pageIdx.",
  });
  const [kept, note] = [
    limited.slice(0, limited.lastIndexOf("\n")),
    limited.slice(limited.lastIndexOf("\n") + 1),
  ];
  assert.ok(text.startsWith(`${kept}\n`));
  assert.ok(kept.length <= 1_000);
  assert.match(
    note,
    new RegExp(
      `^\\[Cut to 1000 characters: the last ${text.length - kept.length} of ${text.length} are omitted\\. Page with pageIdx\\.\\]$`,
      "u",
    ),
  );
});

test("a tail cut keeps the latest lines", () => {
  const text = lines(1_000);
  const limited = limitText(text, { characters: 1_000, keep: "tail" });
  const kept = limited.slice(limited.indexOf("\n") + 1);
  assert.ok(text.endsWith(`\n${kept}`));
  assert.ok(kept.length <= 1_000);
  assert.match(
    limited,
    /^\[Cut to 1000 characters: the first \d+ of \d+ are omitted\.\]\n/u,
  );
});

test("a line longer than the limit is cut inside", () => {
  const limited = limitText("x".repeat(5_000), { characters: 1_000 });
  assert.ok(limited.startsWith(`${"x".repeat(1_000)}\n[Cut`));
});

test("multipart outputs share one budget across text parts and keep images", () => {
  const image = { type: "image", data: "aW1hZ2U=", mediaType: "image/png" };
  const output = [
    { type: "text", text: "a".repeat(600) },
    image,
    { type: "text", text: "b".repeat(600) },
    { type: "text", text: "c" },
  ];
  const limited = limitToolText(output, { characters: 1_000 });
  assert.equal(limited[0], output[0]);
  assert.equal(limited[1], image);
  assert.match(
    (limited[2] as { text: string }).text,
    /^b{400}\n\[Cut to 400 characters/u,
  );
  assert.deepEqual(limited.at(-1), {
    type: "text",
    text: "[1 further text part(s) omitted.]",
  });
  const wrapped = limitToolText(
    { content: output, isError: false },
    { characters: 1_000 },
  );
  assert.equal(wrapped.isError, false);
  assert.deepEqual(wrapped.content, limited);
});
