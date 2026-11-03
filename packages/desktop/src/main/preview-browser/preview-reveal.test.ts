import assert from "node:assert/strict";
import test from "node:test";

import {
  isRevealColor,
  previewCoverCss,
  previewRevealCss,
} from "./preview-reveal.ts";

test("accepts the colors the app's loading screen ends on", () => {
  assert.equal(isRevealColor("rgb(38, 38, 38)"), true);
  assert.equal(isRevealColor("oklch(0.27 0 0)"), true);
  assert.equal(isRevealColor("#262626"), true);
});

test("refuses anything that could add rules to the page", () => {
  assert.equal(isRevealColor("red;}body{display:none"), false);
  assert.equal(isRevealColor("rgb(0 0 0)}html{opacity:0"), false);
  assert.equal(isRevealColor("url(https://example.com/x.png)"), false);
  assert.equal(isRevealColor(""), false);
});

test("covers the whole page above everything, without taking its clicks", () => {
  const css = previewCoverCss("#262626");
  assert.match(css, /:root::after\{/);
  assert.match(css, /position:fixed!important/);
  assert.match(css, /pointer-events:none!important/);
  assert.match(css, /background:#262626!important/);
  assert.match(css, /opacity:1!important/);
});

test("fades the cover out with an animation its opacity does not block", () => {
  const css = previewRevealCss("#262626");
  assert.match(css, /@keyframes blame-preview-reveal/);
  assert.match(css, /animation:blame-preview-reveal \d+ms/);
  assert.doesNotMatch(css, /opacity:1!important/);
});
