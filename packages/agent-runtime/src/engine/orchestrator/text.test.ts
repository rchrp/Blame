import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readableText } from "./text.js";

describe("readableText", () => {
  it("decodes a text escaped twice", () => {
    assert.equal(
      readableText(
        'Compléments :\\n1. Les données.\\n2. `basis` vaut `\\"delay\\"`.',
      ),
      'Compléments :\n1. Les données.\n2. `basis` vaut `"delay"`.',
    );
  });

  it("leaves a text with real line breaks, or a single escape, as written", () => {
    const markdown = '## Contexte\nUse `\\n` and `\\"` in the regex.\\n';
    assert.equal(readableText(markdown), markdown);
    assert.equal(readableText("Split on \\n only."), "Split on \\n only.");
    assert.equal(readableText(undefined), undefined);
  });
});
