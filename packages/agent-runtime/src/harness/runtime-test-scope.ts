import type { CheckObservation } from "./check-observation.js";
import type { TaskCatalogItem } from "./task-catalog.js";
import { sha256 } from "./light-identity.js";

export type TypecheckSelection = { task: string; cwd: string };

/** Forwarded argv and runtime cases do not establish a wrapper's static-check mode. */
export function runtimeTestScope(input: {
  check: CheckObservation;
  script?: string;
  args?: string[];
  changedPaths: string[];
  typecheckSelections?: TypecheckSelection[];
}) {
  const tests = input.changedPaths.filter(path => /\.(?:test|spec)(?:-d)?\.[cm]?tsx?$/u.test(path));
  const args = input.args ?? [];
  if (!tests.length && !args.length) return undefined;
  return {
    kind: "runtime_test_scope" as const,
    runtimeCases: input.check.counts?.executed ?? null,
    testCompilation: "not_established" as const,
    ...(input.script ? { declaredScript: input.script } : {}),
    forwardedArgs: args.slice(0, 12).map(arg => arg.slice(0, 512)),
    forwardedArgsSha256: sha256(JSON.stringify(args)),
    argumentsTruncated: args.length > 12 || args.some(arg => arg.length > 512),
    argumentInterpretation: args.length ? "defined_by_script_not_verified" as const : "no_extra_arguments" as const,
    changedTypeScriptTests: tests.slice(0, 12), changedTestCount: tests.length,
    omittedTests: Math.max(0, tests.length - 12),
    nextTypecheckSelections: (input.typecheckSelections ?? []).slice(0, 3).map(item => ({
      input: { kind: "project" as const, task: item.task, ...(item.cwd !== "." ? { packagePath: item.cwd } : {}) },
      coverage: "inspect_configuration" as const,
    })),
    guidance: "These runtime results do not establish compilation of changed test files. Arguments are forwarded to the declared script; an argument named types does not prove a compiler mode was selected. Inspect the script/configuration and run the actual test compiler when needed. Listed typecheck tasks are selections, not proof of file coverage. This diagnostic runs no command and admits no verification.",
  };
}

export function typecheckSelections(tasks: TaskCatalogItem[], cwd: string): TypecheckSelection[] {
  return tasks.filter(task => task.kind === "typecheck" && task.cwd === cwd)
    .slice(0, 3).map(task => ({ task: task.task_id, cwd: task.cwd }));
}
