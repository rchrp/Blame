import assert from "node:assert/strict";
import test from "node:test";
import {
  previewComposeProjectName,
  previewFailureLogExcerpt,
} from "./preview-readiness.ts";

test("summarizes why a preview container stopped", () => {
  const logs = [
    "web-1 |Preparing pnpm@10.32.1 for immediate activation...",
    "web-1 |",
    "web-1 |> portfolio-v4@0.1.0 dev /workspace",
    "web-1 |> node scripts/dev.mjs --webpack",
    "web-1 | ELIFECYCLE  Command failed with exit code 1.",
    "web-1 |[dev] Docker is not running. Start it, then run `pnpm dev` again.",
  ].join("\n");
  assert.equal(
    previewFailureLogExcerpt(logs),
    "[dev] Docker is not running. Start it, then run `pnpm dev` again.",
  );
  assert.equal(previewFailureLogExcerpt(""), "");
  assert.equal(previewFailureLogExcerpt("a\nb\nc\nd", 2), "c d");
});
