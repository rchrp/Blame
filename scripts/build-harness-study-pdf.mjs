// Compiles docs/semantic-harness-study.tex into the PDF that blame.so serves
// at /research/light-semantic-harness-study.pdf. Needs a TeX distribution
// with latexmk and pdflatex (TeX Live or MacTeX). Run it after editing the study.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs/semantic-harness-study.tex");
const target = join(
  root,
  "packages/vitrine/public/research/light-semantic-harness-study.pdf",
);
const buildDirectory = mkdtempSync(join(tmpdir(), "blame-harness-study-"));

try {
  const result = spawnSync(
    "latexmk",
    [
      "-pdf",
      "-interaction=nonstopmode",
      "-halt-on-error",
      `-outdir=${buildDirectory}`,
      source,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("latexmk was not found. Install TeX Live or MacTeX first.");
  }
  if (result.status !== 0) {
    throw new Error(`latexmk exited with status ${result.status}.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(buildDirectory, "semantic-harness-study.pdf"), target);
  console.log(`Wrote ${target}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(buildDirectory, { force: true, recursive: true });
}
