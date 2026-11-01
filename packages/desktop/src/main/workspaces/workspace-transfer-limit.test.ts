import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkspaceFitsTransfer,
  workspaceTooLargeMessage,
} from "./workspace-transfer-limit.ts";

const megabyte = 1024 * 1024;

test("says how much a workspace sends and what to leave out", () => {
  assert.equal(
    workspaceTooLargeMessage(1.1 * 1024 * megabyte, 256 * megabyte, {
      "docs/A Portfolio/MEMOIRE.pdf": { size: 54 * megabyte },
      "docs/A Portfolio/plan.png": { size: 526 * megabyte },
      "docs/Portfolio.pdf": { size: 22 * megabyte },
      "apps/web/app/page.tsx": { size: 2 * megabyte },
      "pnpm-lock.yaml": { size: megabyte },
    }),
    "This project sends 1.1 GB to the cloud once compressed, over the 256 MB limit. List the large files its preview does not need in .blameignore, for example /docs/** (602 MB), /apps/** (2 MB), /pnpm-lock.yaml (1 MB).",
  );
});

test("refuses before any sandbox starts when media alone exceed the limit", () => {
  const limit = 256 * megabyte;
  // Source code compresses: 400 MB of it is no reason to refuse.
  assertWorkspaceFitsTransfer(
    { "src/bundle.js": { size: 400 * megabyte } },
    limit,
  );
  // PDFs barely compress and travel twice: 130 MB of them already exceed it.
  assert.throws(
    () =>
      assertWorkspaceFitsTransfer(
        { "docs/A Portfolio/MEMOIRE.pdf": { size: 130 * megabyte } },
        limit,
      ),
    /sends at least 260 MB to the cloud once compressed, over the 256 MB limit\..*\/docs\/\*\* \(130 MB\)/,
  );
});
