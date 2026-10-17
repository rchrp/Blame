import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeSymbolicSource,
  type SymbolicRequest,
} from "./symbolic-analysis.js";
import { compileSymbolicProgram } from "./symbolic-program.js";
import { parseSymbolicValues } from "./symbolic-solver.js";

const request = (
  source = "export function choose(x: number) { return x + 1; }",
): SymbolicRequest => ({
  source,
  functionName: "choose",
  inputs: { x: { min: -4, max: 4 } },
  assertion: "result > x",
});
const solverPath = process.env.BLAME_Z3_PATH ?? "z3";
const realSolver = spawnSync(solverPath, ["-version"], {
  timeout: 1000,
  encoding: "utf8",
});
const solverAvailable =
  realSolver.status === 0 && /^Z3 version /.test(realSolver.stdout);

test(
  "real Z3 reproduces an actual wrong branch, bound to source and query hashes",
  { skip: !solverAvailable },
  async () => {
    const source =
      "export function choose(x: number) { if (x < 0) return x - 1; return x + 1; }";
    const result = await analyzeSymbolicSource({
      ...request(source),
      solverPath,
    });
    assert.equal(result.status, "counterexample");
    assert.equal(result.validationAdmission, false);
    assert.equal(result.witness?.concretelyReproduced, true);
    const x = result.witness!.inputs.x as number;
    assert.ok(x < 0 && x >= -4);
    assert.equal(result.witness!.result, x - 1);
    assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(result.solver!.querySha256, /^[a-f0-9]{64}$/);
  },
);

test(
  "real Z3 establishes only bounded absence of counterexamples",
  { skip: !solverAvailable },
  async () => {
    const result = await analyzeSymbolicSource({ ...request(), solverPath });
    assert.equal(result.status, "bounded_no_counterexample");
    assert.equal(result.witness, undefined);
    assert.equal(result.validationAdmission, false);
    assert.match(result.scope, /does not establish repository correctness/);
  },
);

test(
  "real Z3 handles boolean arrows, constants and branch-local bindings",
  { skip: !solverAvailable },
  async () => {
    const result = await analyzeSymbolicSource({
      source:
        "const choose = (x: number, enabled: boolean): number => { const delta = 2; if (enabled) { const next = x + delta; return next; } return x - delta; };",
      functionName: "choose",
      inputs: { x: { min: -5, max: 5 }, enabled: { type: "boolean" } },
      assertion: "enabled ? result === x + 2 : result === x - 2",
      solverPath,
    });
    assert.equal(result.status, "bounded_no_counterexample");
  },
);

test(
  "real Z3 searches a nonlinear integer property and concrete witness",
  { skip: !solverAvailable },
  async () => {
    const result = await analyzeSymbolicSource({
      ...request("function choose(x: number) { return x * x; }"),
      assertion: "result < 9",
      solverPath,
    });
    assert.equal(result.status, "counterexample");
    assert.ok((result.witness!.result as number) >= 9);
  },
);

const unsupportedCases: [string, Partial<SymbolicRequest>, string][] = [
  [
    "calls",
    { source: "function choose(x: number) { return Math.abs(x); }" },
    "unsupported_expression",
  ],
  [
    "globals",
    { source: "function choose(x: number) { return x + offset; }" },
    "unbound_identifier",
  ],
  [
    "floats",
    { source: "function choose(x: number) { return x + 0.5; }" },
    "non_safe_integer_literal",
  ],
  [
    "NaN",
    { inputs: { x: { min: NaN, max: 4 } } },
    "finite_safe_integer_bounds",
  ],
  [
    "Infinity",
    { inputs: { x: { min: 0, max: Infinity } } },
    "finite_safe_integer_bounds",
  ],
  [
    "fractional input",
    { inputs: { x: { min: 0.5, max: 4 } } },
    "finite_safe_integer_bounds",
  ],
  [
    "unsafe arithmetic",
    { inputs: { x: { min: 0, max: Number.MAX_SAFE_INTEGER } } },
    "unsafe_integer_intermediate",
  ],
  [
    "unsafe discarded branch",
    {
      source:
        "function choose(x: number) { return false ? x * 9999999999999 : x; }",
      inputs: { x: { min: 1, max: 10000 } },
    },
    "unsafe_integer_intermediate",
  ],
  [
    "division",
    { source: "function choose(x: number) { return x / 2; }" },
    "unsupported_binary_operator",
  ],
  [
    "coercive comparison",
    { assertion: "result == x" },
    "unsupported_binary_operator",
  ],
  [
    "mutation",
    { source: "function choose(x: number) { x++; return x; }" },
    "unsupported_statement",
  ],
  [
    "loops",
    { source: "function choose(x: number) { while (x > 0) {} return x; }" },
    "unsupported_statement",
  ],
  [
    "missing returns",
    { source: "function choose(x: number) { if (x > 0) return x; }" },
    "all_paths_must_return",
  ],
  [
    "duplicate declaration",
    {
      source:
        "function choose(x: number) { return x; } function choose(x: number) { return x + 1; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "escaped class declaration collision",
    {
      source: "class \\u0063hoose {} function choose(x: number) { return x; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "import equals declaration collision",
    {
      source:
        "import choose = require('./other'); function choose(x: number) { return x; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "import declaration collision",
    {
      source:
        "import { choose } from './other'; function choose(x: number) { return x; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "destructured declaration collision",
    {
      source:
        "const { choose } = foreign; function choose(x: number) { return x; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "invalid return annotation",
    { source: "function choose(x: number): boolean { return x; }" },
    "return_type_mismatch",
  ],
  [
    "overloads",
    {
      source:
        "function choose(x: number): number; function choose(x: number) { return x; }",
    },
    "function_missing_ambiguous",
  ],
  [
    "ambient function erasure",
    { source: "declare function choose(x: number) { return x; }" },
    "unsupported_function_shape",
  ],
  [
    "ambient arrow erasure",
    { source: "declare const choose = (x: number) => x;" },
    "function_missing_ambiguous",
  ],
  [
    "this pseudo parameter erasure",
    {
      source: "function choose(this: number, x: number) { return x; }",
      inputs: { this: { min: 0, max: 2 }, x: { min: 0, max: 2 } },
    },
    "input_contract_mismatch",
  ],
  [
    "async",
    { source: "async function choose(x: number) { return x; }" },
    "unsupported_function_shape",
  ],
  [
    "generator",
    { source: "function* choose(x: number) { return x; }" },
    "unsupported_function_shape",
  ],
  [
    "reserved result",
    {
      source: "function choose(result: number) { return result; }",
      inputs: { result: { min: 0, max: 2 } },
    },
    "input_contract_mismatch",
  ],
  ["missing contract", { inputs: {} }, "input_contract_mismatch"],
  [
    "extra contract",
    { inputs: { x: { min: 0, max: 2 }, z: { min: 0, max: 2 } } },
    "input_contract_mismatch",
  ],
  [
    "shadowed local",
    { source: "function choose(x: number) { const x = 1; return x; }" },
    "shadowed_or_duplicate_local",
  ],
  [
    "escaped block local",
    {
      source:
        "function choose(x: number) { if (x > 0) { const hidden = 2; } return hidden; }",
    },
    "unbound_identifier",
  ],
  [
    "assertion injection",
    { assertion: "result > 0); console.log('bad'); (true" },
    "source_parse_error|assertion_expression_required",
  ],
  [
    "escaped assertion wrapper",
    { assertion: "true); //" },
    "assertion_expression_required",
  ],
  [
    "extra assertion declaration",
    { assertion: "true), rogue = (false" },
    "assertion_expression_required",
  ],
  [
    "nonboolean assertion",
    { assertion: "result + 1" },
    "boolean_assertion_required",
  ],
];
for (const [label, change, reason] of unsupportedCases)
  test(`rejects ${label} without a solver call or inferred proof`, async () => {
    const result = await analyzeSymbolicSource({
      ...request(),
      ...change,
      solverPath: "/missing/never-run-z3",
    });
    assert.equal(result.status, "unknown");
    assert.match(result.reason, new RegExp(reason));
    assert.equal(result.solver, undefined);
    assert.equal(result.validationAdmission, false);
  });

test("missing solver and cancelled invocation remain unknown", async () => {
  const missing = await analyzeSymbolicSource({
    ...request(),
    solverPath: "/missing/blame-z3",
  });
  assert.equal(missing.status, "unknown");
  assert.equal(missing.reason, "solver_unavailable");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await analyzeSymbolicSource({
    ...request(),
    signal: controller.signal,
  });
  assert.equal(cancelled.reason, "cancelled");
});

test("model parser rejects extra values, duplicate bindings and expressions", () => {
  assert.deepEqual(
    [...parseSymbolicValues("sat\n((p0 (- 4)) (p1 true))\n", ["p0", "p1"])],
    [
      ["p0", -4],
      ["p1", true],
    ],
  );
  for (const output of [
    "sat\n((p0 1)(p0 2))",
    "sat\n((p0 (+ 1 2)))",
    "sat\n((p0 1))junk",
    "sat\n((p0 1)(p8 2))",
  ])
    assert.throws(
      () => parseSymbolicValues(output, ["p0"]),
      /invalid_solver_model/,
    );
});

test("same contracts compare original AST outcomes with generated formulas", () => {
  const program = compileSymbolicProgram(
    request(
      "function choose(x: number) { const y = x * x; if (y > 3) return -y; return y + 1; }",
    ),
  );
  for (let x = -4; x <= 4; x++) {
    const expected = x * x > 3 ? -(x * x) : x * x + 1;
    assert.deepEqual(program.reproduce({ x }), {
      result: expected,
      assertion: expected > x,
    });
  }
});

async function fakeSolver(
  script: string,
  body: (path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "blame-symbolic-process-"));
  try {
    const executable = join(directory, "z3-fixture");
    await writeFile(
      executable,
      `#!${process.execPath}\nif (process.argv.includes('-version')) { console.log('Z3 version 4.15.4 - fixture'); } else { ${script} }\n`,
    );
    await chmod(executable, 0o700);
    await body(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "solver hang is bounded and never reported as unsat",
  { skip: process.platform === "win32" },
  async () => {
    await fakeSolver("setInterval(() => {}, 1000);", async (path) => {
      const started = Date.now();
      const result = await analyzeSymbolicSource({
        ...request(),
        solverPath: path,
        timeoutMs: 250,
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "timed_out");
      assert.ok(Date.now() - started < 2500);
    });
  },
);

test(
  "unreproduced solver witness is rejected",
  { skip: process.platform === "win32" },
  async () => {
    await fakeSolver(
      "process.stdin.once('data', () => { console.log('sat'); process.stdin.once('data', () => { console.log('((p0 0))'); process.exit(0); }); });",
      async (path) => {
        const result = await analyzeSymbolicSource({
          ...request(),
          solverPath: path,
        });
        assert.equal(result.status, "unknown");
        assert.equal(result.reason, "counterexample_not_reproduced");
      },
    );
  },
);

test(
  "excessive solver output and active cancellation remain unknown",
  { skip: process.platform === "win32" },
  async () => {
    await fakeSolver(
      "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);",
      async (path) => {
        const result = await analyzeSymbolicSource({
          ...request(),
          solverPath: path,
        });
        assert.equal(result.status, "unknown");
        assert.equal(result.reason, "output_limit");
      },
    );
    await fakeSolver("setInterval(() => {}, 1000);", async (path) => {
      const controller = new AbortController();
      const pending = analyzeSymbolicSource({
        ...request(),
        solverPath: path,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 75);
      const result = await pending;
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "cancelled");
    });
  },
);

test("bounds repeated symbolic expansion before exponential expression allocation", async () => {
  const locals = Array.from(
    { length: 40 },
    (_, index) =>
      `const v${index} = ${index ? `v${index - 1}` : "x"} === ${index ? `v${index - 1}` : "x"};`,
  ).join(" ");
  const result = await analyzeSymbolicSource({
    ...request(`function choose(x: number) { ${locals} return v39; }`),
    assertion: "result",
    solverPath: "/missing/never-run-z3",
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "smt_size_limit");
});
