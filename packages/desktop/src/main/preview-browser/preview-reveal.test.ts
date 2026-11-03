import assert from "node:assert/strict";
import test from "node:test";

import {
  isRevealColor,
  previewCoverCss,
  previewRevealCss,
} from "./preview-reveal.ts";

test("accepts the hex color the app's loading screen ends on", () => {
  assert.equal(isRevealColor("#1b1b1b"), true);
  assert.equal(isRevealColor("#E8E8E8"), true);
});

test("refuses anything else, so nothing but a color reaches the view", () => {
  assert.equal(isRevealColor("red;}body{display:none"), false);
  assert.equal(isRevealColor("oklch(0.22 0 0)"), false);
  assert.equal(isRevealColor("#1b1b1b}html{opacity:0"), false);
  assert.equal(isRevealColor(""), false);
});

// A rule on a pseudo-element keeps its style in the page once removed: the
// cover must be on the root element itself.
test("hides the page on its root element, not on a pseudo-element", () => {
  const css = previewCoverCss();
  assert.match(css, /^html\{/);
  assert.match(css, /opacity:0!important/);
  assert.doesNotMatch(css, /::/);
});

test("fades the page in with an animation its opacity does not block", () => {
  const css = previewRevealCss("blame-preview-reveal-x");
  assert.match(
    css,
    /@keyframes blame-preview-reveal-x\{from\{opacity:0\}to\{opacity:1\}\}/,
  );
  assert.match(
    css,
    /html\{animation:blame-preview-reveal-x \d+ms ease-out both!important\}/,
  );
  assert.doesNotMatch(css, /opacity:[01]!important/);
  assert.doesNotMatch(css, /::/);
});
