import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  cloudTransferIssues,
  measureCloudTransfer,
  type CloudTransferSize,
} from "./project-cloud-transfer-size.js";

const megabyte = 1024 * 1024;

// Shaped on JuliettePortfolio of 2026-11-01: 602 MB of source PDFs and
// photos in docs/ that only one-off asset scripts and tests read.
const juliette: CloudTransferSize = {
  bytes: 603 * megabyte,
  files: 204,
  largest: [
    { path: "docs", bytes: 602 * megabyte, directory: true },
    { path: "apps", bytes: megabyte, directory: true },
  ],
  sizes: {
    docs: 602 * megabyte,
    "docs/A Portfolio": 580 * megabyte,
    apps: megabyte,
  },
};

test("warns when a cloud preview would send more than it can", () => {
  const [issue] = cloudTransferIssues(juliette, undefined, []);
  assert.equal(issue?.severity, "warning");
  assert.match(issue!.rule, /about 603 MB of files remain/);
  assert.match(issue!.rule, /Largest: \/docs\/\*\* \(602 MB\)/);
  const rule = (pattern: string) => [{ pattern, reason: "Source PDFs" }];
  assert.deepEqual(
    cloudTransferIssues(juliette, undefined, rule("/docs/**")),
    [],
  );
  assert.deepEqual(
    cloudTransferIssues(juliette, undefined, rule("/docs/A Portfolio/**")),
    [],
  );
  // A manual rule counts; the generated block is replaced by the submission.
  assert.deepEqual(cloudTransferIssues(juliette, "/docs/\n", []), []);
  const generated =
    "# BEGIN BLAME GENERATED CLOUD EXCLUSIONS\n/docs/**\n# END BLAME GENERATED CLOUD EXCLUSIONS\n";
  assert.equal(cloudTransferIssues(juliette, generated, []).length, 1);
});

test("measures the files Git would send", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-transfer-"));
  try {
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, { cwd: root });
    await git("init", "--quiet");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/plan.pdf"), Buffer.alloc(3000));
    await writeFile(join(root, "notes.txt"), Buffer.alloc(500));
    await writeFile(join(root, "build.zip"), Buffer.alloc(9000));
    await writeFile(join(root, ".gitignore"), "build.zip\n");
    await git("add", "docs/plan.pdf", ".gitignore");
    const transfer = await measureCloudTransfer(root);
    // The ignored archive is left out; the untracked note is sent.
    assert.equal(transfer?.bytes, 3000 + 500 + ".gitignore\n".length - 1);
    assert.equal(transfer?.files, 3);
    assert.deepEqual(transfer?.largest[0], {
      path: "docs",
      bytes: 3000,
      directory: true,
    });
    assert.equal(transfer?.sizes["docs/plan.pdf"], 3000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
