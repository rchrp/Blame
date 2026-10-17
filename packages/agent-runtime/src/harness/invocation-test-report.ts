import { lstat, mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./light-identity.js";
import { parseTestReport, parseTestReports } from "./test-report.js";
import type { WorkspaceSnapshot } from "./workspace-files.js";

export async function invocationTestReport(root: string) {
  // Node's --import accepts a file URL; JSON quoting preserves spaces in NODE_OPTIONS.
  const hook = new URL("./invocation-test-preload.js", import.meta.url);
  const hookHash = sha256(await readFile(fileURLToPath(hook)));
  const parent = join(root, ".blame/harness/test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "vitest-invocation-"));
  return {
    environment: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(hook.href)}`.trim(),
      HARNESS_VITEST_REPORT_DIRECTORY: directory },
    async read(before: WorkspaceSnapshot, after: WorkspaceSnapshot) {
      try {
        const starts = (await readdir(directory)).filter(name => /^[a-f0-9-]+\.start\.json$/u.test(name)).sort();
        if (!starts.length || starts.length > 32) return undefined;
        const reports: string[] = [], invocations: unknown[] = [];
        let bytes = 0;
        const owned = async (name: string) => {
          const path = join(directory, name), stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || (bytes += stat.size) > 2 * 1024 * 1024 ||
              !(await realpath(path)).startsWith((await realpath(directory)) + sep)) throw Error("unowned_report");
          return readFile(path, "utf8");
        };
        for (const name of starts) {
          const startText = await owned(name), start = JSON.parse(startText);
          const end = JSON.parse(await owned(name.replace(".start.", ".end.")));
          if (start.format !== "blame-vitest-invocation-v1" || start.runner?.version !== "3.2.4" ||
              start.runner.name !== "vitest" || start.id !== name.slice(0, -11) ||
              !Number.isInteger(end.exitCode) ||
              JSON.stringify(start) !== JSON.stringify(Object.fromEntries(Object.entries(end).filter(([key]) => key !== "exitCode")))) return undefined;
          const text = await owned(`${start.id}.report.json`), report = parseTestReport(text), parsed = JSON.parse(text);
          if (!report || !Array.isArray(parsed.testResults) || parsed.testResults.length > 128) return undefined;
          const files = parsed.testResults.map((file: { name: string; assertionResults?: unknown[] }) => {
            const path = relative(root, file.name).replaceAll("\\", "/");
            if (path.startsWith("../") || !path || path.startsWith("/")) throw Error("outside_workspace");
            const oldHash = before.fileStates.find(item => item.path === path)?.hash ?? null;
            const newHash = after.fileStates.find(item => item.path === path)?.hash ?? null;
            return { path, cases: file.assertionResults?.length ?? null, sourceSha256Before: oldHash,
              sourceSha256After: newHash, unchanged: oldHash !== null && oldHash === newHash };
          });
          // A child exit failure cannot disappear behind a successful wrapper.
          if (end.exitCode !== 0 && !report.setupFailed && report.counts.failed === 0) return undefined;
          reports.push(text); invocations.push({ ...end, args: start.args.slice(0, 32).map((arg: string) => arg.slice(0, 256)),
            argsSha256: sha256(JSON.stringify(start.args)), argsTruncated: start.args.length > 32,
            reportSha256: sha256(text), files: files.slice(0, 16), fileCount: files.length, filesTruncated: files.length > 16 });
        }
        const combined = parseTestReports(reports);
        return combined ? { report: combined, evidence: { invocationId: relative(root, directory),
          hookSha256: hookHash, invocations: invocations.slice(0, 8), invocationCount: invocations.length, invocationsTruncated: invocations.length > 8, typeFileSelection: "unknown",
          boundary: "Invocation-owned Vitest 3.2.4 reported cases; runtime versus configured typecheck mode is not established. Counts may include repeated invocations. File hashes bind observed tests, not dependencies or typecheck selection. No source admission or user acceptance." } } : undefined;
      } catch { return undefined; }
    },
  };
}
