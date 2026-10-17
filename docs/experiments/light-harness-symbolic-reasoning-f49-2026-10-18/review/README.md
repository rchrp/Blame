# Independent prototype soundness review

This is a post-hoc local review of the **new, unshipped symbolic prototype**, before model evaluation. It does not describe defects in previous `main`, fresh benchmark confirmation, or a measured success/token gain. No model requests were made.

The review found ambient declarations that were erased by TypeScript despite receiving a bounded result, erased `this` pseudo-parameters counted as scalar inputs, an escaped assertion wrapper, and target-name collisions through Unicode spelling or import-equals declarations. The engine owner added conservative refusals and regression tests. `independent-controls-final.json` binds the corrected engine's exact source bytes and confirms that all six adversarial cases return `unknown` without a solver call. Initial adverse observations were interactive and were not byte-bound replays; their exact inputs and interpretations are retained. The earlier `independent-controls.json` captures the intermediate engine after the first four refusals and is kept separately.

Twelve constructed supported functions also compare the AST interpreter and real Z3 against transpiled JavaScript on **all 85 finite input assignments**. They cover branch-local bindings, nested blocks, ordered declarations, integer arithmetic, boolean expressions and two violated properties. Every classification agrees; each returned witness also reproduces against actual JavaScript. No legal supported-subset semantic mismatch was found in this small panel. Safe-integer interval checks remain conservative. Negative zero cannot be distinguished by the admitted operators; the experiment does not establish support for division, `Object.is`, coercion, globals or arbitrary TypeScript.

Reproduce with pinned Z3 available, from repository root and using a new output path:

```sh
node --import ./.blame/research/validation-scope-f44/dependencies/node_modules/tsx/dist/loader.mjs tools/terminal_bench/symbolic-review-study/review.mjs packages/agent-runtime/src/harness/symbolic-analysis.ts /tmp/blame-z3-f46/bin/z3 /tmp/new-symbolic-review.json
node tools/terminal_bench/symbolic-review-study/verify.mjs /tmp/new-symbolic-review.json
```

The verifier checks recorded source contents, source identities, classifications and refusals. The replay executes the independent JavaScript cross-check and solver controls and refuses to overwrite evidence; the verifier is read-only. Global code correctness and source validation admission remain unclaimed.
