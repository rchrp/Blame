/** A runner diagnostic, never proof that any particular test file was typechecked. */
export type TestTypeEvidence = {
  runner: "vitest";
  requested: boolean | null;
  sourceErrorsIgnored: boolean | null;
  reportedErrors: "none" | "present" | "unknown";
  testFileSelection: "unknown";
  note: string;
};

/**
 * Vitest 3.2.4 prints "Type Errors no errors" even when no typecheck test file
 * matches its separate selection. Runtime case counts and this heading cannot
 * establish file membership, compiler coverage, or source verification.
 */
export function testTypeEvidence(command: string, output: string, interrupted: boolean): TestTypeEvidence | undefined {
  if (!/\bvitest(?:\.[cm]?js)?\b/u.test(command) ||
    !/--(?:no-)?typecheck\b/u.test(command) && !/^\s*Type Errors\s/um.test(output)) return undefined;

  const parts = command.trim().split(/\s+&&\s+/u);
  const literal = parts.length <= 2 && (parts.length === 1 ||
    /^tsc(?:\s+[\w./:=@+-]+)*$/u.test(parts[0]!)) &&
    /^(?:vitest|node\s+(?:[\w./-]+\/)?vitest\.[cm]?js)(?:\s+[\w./:=@+-]+)*$/u.test(parts.at(-1)!);
  const banners = [...output.matchAll(/^\s*RUN\s+v([^\s]+)[^\r\n]*$/gmu)];
  const supported = literal && !interrupted && banners.length === 1 && banners[0]![1] === "3.2.4";
  const tokens = supported ? parts.at(-1)!.split(/\s+/u) : [];
  const summaries = [...output.matchAll(/^\s*Type Errors\s+([^\r\n]+)$/gmu)];
  const summary = supported && summaries.length === 1 ? summaries[0]![1]!.trim() : undefined;
  const failed = /^(\d+) failed$/u.exec(summary ?? "");
  // The heading counts failing typecheck cases, not suite-level compiler errors.
  // Real Vitest can print "no errors" next to a failed TypeCheckError suite.
  const contradictory = summary === "no errors" && /\b(?:TypeCheckError|TSError):|\berror TS\d+:/u.test(output);
  return {
    runner: "vitest",
    requested: booleanFlag(tokens, ["typecheck", "typecheck.enabled"], "typecheck.only"),
    sourceErrorsIgnored: booleanFlag(tokens, ["typecheck.ignoreSourceErrors"]),
    reportedErrors: contradictory ? "unknown" : summary === "no errors" ? "none" : failed && Number(failed[1]) > 0 ? "present" : "unknown",
    testFileSelection: "unknown",
    note: "Vitest runtime and typecheck selections differ. Summary text and case counts establish no delivered-test typecheck coverage; file selection is unknown. This diagnostic grants no verification.",
  };
}

function booleanFlag(tokens: string[], names: string[], enablingOnly?: string): boolean | null {
  const values: boolean[] = [];
  for (const [index, token] of tokens.entries()) {
    for (const name of [...names, ...(enablingOnly ? [enablingOnly] : [])]) {
      const negative = token === `--no-${name}`;
      const matched = token === `--${name}` || negative || token === `--${name}=true` || token === `--${name}=false`;
      if (!matched) continue;
      const next = tokens[index + 1];
      const value = negative || token.endsWith("=false") || token === `--${name}` && next === "false" ? false : true;
      if (name !== enablingOnly || value) values.push(value);
    }
  }
  return values.length && values.every((value) => value === values[0]) ? values[0]! : null;
}
