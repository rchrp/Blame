F49 local symbolic reasoning diagnostic

`corpus.json` fixes the seed, generator parameters, 18 supported scalar fixtures and eight unsupported controls before solver outcomes. These are constructed mechanism diagnostics, including deliberately defective variants, rather than held-out agent tasks. The production analyzer models an isolated selected function body; module initialization, imported callees and external rebinding are outside this scope.

The experiment exhaustively executes every bounded input in actual JavaScript emitted by the pinned TypeScript compiler. It compares the existence of a violated supplied property to the analyzer's Z3 classification, then executes each reported witness in that JavaScript. Unsupported syntax, unsafe intermediates and non-finite contracts must remain unknown. The non-finite control records `"Infinity"` in the corpus with an explicit decode flag; the production API refuses it before invoking a solver.

Reproduce in a fresh output directory after building `@blame/agent-runtime` and installing the recorded Z3 version externally:

```sh
node tools/terminal_bench/symbolic-reasoning-study/local.mjs prepare /absolute/fresh-output
BLAME_Z3_PATH=/absolute/pinned/z3 node tools/terminal_bench/symbolic-reasoning-study/local.mjs run /absolute/fresh-output
node tools/terminal_bench/symbolic-reasoning-study/verify-local.mjs /absolute/fresh-output
```

The run records source, compiled analyzer and solver binary hashes. The verifier independently re-enumerates the recorded JavaScript and replays witnesses without calling Z3. Outputs refuse replacement. Durations are single sequential host observations; enumeration includes transpilation, VM setup and bounded VM execution, while analyzer duration includes translation, solver identification and solving. They establish no native execution speed comparison, model success improvement or token saving. Neither a reproduced witness nor bounded absence of a counterexample admits repository validation or user acceptance.
