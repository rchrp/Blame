import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTooLargeMessage } from "./workspace-transfer-limit.ts";

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
