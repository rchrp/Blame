#!/usr/bin/env node
// Sorts the failures of run.mjs's rust mode by cause, from its --json output:
//   node crates/blame-harness/conformance/classify.mjs results.json
import { readFileSync } from "node:fs";

const results = JSON.parse(readFileSync(process.argv[2], "utf8"));
const causes = [
  ["edit_code (later part)", /edit_code is not available/u],
  ["run_task (later part)", /run_task is not available/u],
  ["finish_task / completion (later part)", /finish_task is not available|LightFinishService|finish/u],
  ["@checks (validation part)", /@checks/u],
];
const totals = {};
const unexplained = [];
for (const [file, result] of Object.entries(results)) {
  for (const failure of result.rust?.failed ?? []) {
    const cause = causes.find(([, pattern]) => pattern.test(failure.error))?.[0] ?? "other";
    totals[cause] = (totals[cause] ?? 0) + 1;
    if (cause === "other") unexplained.push(`${file}: ${failure.name} — ${failure.error}`);
  }
}
console.log(totals);
for (const line of unexplained) console.log(line);
