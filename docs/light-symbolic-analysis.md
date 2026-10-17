# Optional bounded symbolic reasoning

Light keeps its five tools. An experimental `run_task` analysis operation searches for counterexamples in an isolated, typed TypeScript scalar function. It is disabled in the model's tool schema by default. Ordinary runs do not load the symbolic engine or start a solver.

Enable it in the agent runtime environment with `BLAME_AGENT_SYMBOLIC_ANALYSIS=true`. Install a local Z3 executable separately and set `BLAME_Z3_PATH` to its absolute path, or make `z3` available on PATH. The harness never downloads a solver at execution time. The study pins `z3-solver==4.15.4.0`; its Python wheel provides a `bin/z3` executable. A missing executable produces an unknown analysis result.

For example, after locating this function:

```ts
export function remaining(capacity: number, used: number): number {
  if (used > capacity) return 0;
  return capacity + used;
}
```

the agent can request:

```json
{
  "kind": "analyze",
  "target": "src/budget.ts#remaining",
  "inputs": {
    "capacity": { "min": 0, "max": 100 },
    "used": { "min": 0, "max": 100 }
  },
  "assertion": "result === (used > capacity ? 0 : capacity - used)",
  "timeoutMs": 2500
}
```

The property and input bounds are supplied assumptions, not inferred user requirements. All function parameters must have matching contracts. Boolean parameters use `{ "type": "boolean" }`. Assertions may reference the original parameters and the reserved name `result`.

The engine translates the selected source body and assertion into SMT constraints. A satisfying input is re-evaluated through a separate interpreter of the supported original AST. The result records the source revision and hash, solver version, query hash, assumptions and witness. The source is checked again after solving; changes discard the conclusion as stale. The study additionally executes witnesses in actual transpiled JavaScript; production does not evaluate arbitrary repository code during analysis.

Results have three meanings:

- `counterexample`: a violating input was reproduced under the supported isolated-function semantics. Execute a real regression test to establish its relevance to the application.
- `bounded_no_counterexample`: no violation exists within the supplied domain and supported semantics. This is conditional on the property, bounds and translator; it establishes neither module initialization behavior nor all caller inputs.
- `unknown`: unsupported code, unsafe arithmetic, missing solver, cancellation, timeout, ambiguous identity, invalid output or another unresolved condition. It grants no positive evidence.

The initial subset supports explicitly typed number/boolean parameters, safe integer constants, immutable local bindings, branches, returns, conditionals, strict comparisons and bounded integer addition, subtraction and multiplication. Every arithmetic intermediate must remain within JavaScript's safe integer range. Calls, loops, mutation, objects, arrays, globals, coercion, division, floating-point domains, NaN, Infinity, async functions and ambiguous/ambient declarations are refused. Analysis models the selected body; external rebinding and module side effects remain outside its scope.

Queries are bounded by source/AST/path/SMT/output limits. Solver identity and solve processes share a per-call time budget, capped at ten seconds, with cancellation and process cleanup. There is no automatic execution of additional project checks and no completion gate based on solver output. Analysis grants no edit coverage, records no passing validation, and never satisfies required test invocations or user acceptance by itself.

F46, F49 and F50 keep invariant checks, local translator measurements and model comparisons separate in `docs/experiments`. The feature stays opt-in until its task-quality and resource effects justify broader use. Navigation and test-report diagnostics are separately implemented mechanisms.
