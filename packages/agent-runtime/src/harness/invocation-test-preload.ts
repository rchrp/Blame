// Invocation-local observation only. Never change test selection or claim type coverage.
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const directory = process.env.HARNESS_VITEST_REPORT_DIRECTORY;
if (directory && process.argv[1]) {
  try {
    const entry = realpathSync(process.argv[1]);
    if (basename(entry) !== "vitest.mjs") throw Error("not_vitest");
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
    const originalArgs = process.argv.slice(2);
    if (pkg.name === "vitest" && pkg.version === "3.2.4" && originalArgs.includes("run") &&
        !originalArgs.some(arg => /^(?:--reporter|--outputFile|--watch|--ui|--browser|--typecheck)/u.test(arg))) {
      const id = randomUUID(), report = join(directory, `${id}.report.json`);
      const record = { format: "blame-vitest-invocation-v1", id, runner: { name: pkg.name, version: pkg.version },
        executable: process.execPath, nodeVersion: process.version, entry, cwd: process.cwd(), args: originalArgs };
      writeFileSync(join(directory, `${id}.start.json`), JSON.stringify(record));
      process.argv.push("--reporter=default", "--reporter=json", `--outputFile.json=${report}`);
      process.once("exit", code => {
        try { writeFileSync(join(directory, `${id}.end.json`), JSON.stringify({ ...record, exitCode: code })); }
        catch { /* Incomplete observation remains unknown. */ }
      });
    }
  } catch { /* Unsupported CLI/layout: execute unchanged, observe no report. */ }
}
