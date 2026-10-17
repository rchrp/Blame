# F46: bounded Z3 admission-invariant study

Z3 agrees with the current Light admission behavior on **1,536 prespecified states**. It supplies counterexamples for **nine dangerous changes to actual harness code**; each witness distinguishes the unchanged runtime from a mutated scratch copy. All **18 latest-invocation controls** and **six non-mutating controls** match the independent expectation. No existing implementation defect was found in this bounded domain.

The study uses `z3-solver==4.15.4.0` as an offline development dependency. It introduces no solver into production, no new agent tool, and no model calls. The domain and scripts were bound in `protocol.json` before executing the real runtime.

## Mechanism and boundary

The eight Boolean factors are: presence of a test observation, matching source revision, matching recorded file bytes, exact task, exact argv, exact cwd, a required test obligation, and a separate admitted passing build. Six test outcomes cover observed pass, unobserved exit zero, zero tests, no files selected, code failure, and unavailable environment. Tests have the same `unknown` admission status as the current task runner; observed execution alone grants no source scope. A passing build supplies explicit source paths when that factor is enabled.

Each state is constructed through the real `SessionJournal.recordValidation`. Actual `completionSnapshot` filters freshness and preserves the latest observation per exact invocation. Actual `LightFinishService.finish` checks failures, matches obligations, evaluates scope and emits completion. A per-instance `validateIfNeeded` override returns fixed required invocations and task IDs. This deliberately bypasses command selection, execution and refresh, so an unsatisfied obligation remains observable instead of being automatically rerun. This is an **admission-state differential test**, not a complete replay of agent operation.

The Python scalar specification and Z3 formula are independently written from the Node adapter. Their bounded truth tables agree (`unsat` for any disagreement), and every scalar expectation is checked against the real runtime. This is stronger than checking only that an abstract model is internally consistent; it remains conditional on the selected state abstraction and fixture correctness.

Z3 witnesses are materialized against scratch copies with one concrete change each: removed revision guard, removed file-hash guard, removed task/argv/cwd equality, relaxed observed-test evidence, accepting a no-files discovery failure, ignoring required obligations, or ignoring actual code failures. The original runtime files are hashed before and after. Freshness witnesses can expose stale failures incorrectly blocking completion as well as stale success admission. Additional same/different-invocation controls verify that a later pass replaces a failure only for the same literal invocation.

Some cases intentionally combine a current revision field with stale recorded bytes. These adversarial journal inputs test the second guard; they are not claimed to arise through a normal task-runner invocation. Runner-output parsing, catalog interpretation, actual processes, source mutation during execution, concurrent writers and environment identity are outside this experiment. Admitted build scope reflects current harness rules and establishes no semantic code correctness or user acceptance.

## Results and decision

| Measurement | Result |
| --- | ---: |
| Prespecified runtime states | 1,536 / 1,536 match |
| Concrete mutation controls | 9 / 9 discriminate |
| Latest-invocation controls | 18 / 18 match |
| Non-mutating controls | 6 / 6 match |
| Python scalar case generation | 0.0032 s |
| Nine Z3 `check()` calls | 0.0275 s |
| Symbolic/scalar truth-table equivalence check | 0.0326 s |
| Real baseline fixtures | 32.20 s |
| Scratch-copy mutation fixtures | 2.31 s |
| Model requests | 0 |

These are single local wall-clock observations, not a performance benchmark. Python import/startup and truth-table construction are excluded from the individual solver-check times; runtime measurements include filesystem work and subprocess-based workspace inspection. The scalar enumeration is already cheap for this small domain. **No solver speed advantage, task-success improvement or token reduction is demonstrated.**

Keep this optional development study and its mutation controls. Keep simple runtime predicates in TypeScript. Broader formal reasoning about application code requires a separate semantics translator, assumptions and replayed counterexamples; no such general translator is demonstrated here.

## Reproduction

Build the selected runtime first, using the repository's pinned pnpm. Create a separate environment and run new output paths (the scripts refuse overwriting evidence):

```sh
python -m venv /tmp/blame-formal-reproduction
/tmp/blame-formal-reproduction/bin/pip install -r tools/terminal_bench/formal-validation-study/requirements.txt
/tmp/blame-formal-reproduction/bin/python tools/terminal_bench/formal-validation-study/model.py /tmp/formal-model-new.json
node tools/terminal_bench/formal-validation-study/run.mjs packages/agent-runtime/dist/harness /tmp/formal-model-new.json /tmp/formal-runtime-new.json
node tools/terminal_bench/formal-validation-study/verify.mjs
```

The final command checks the archived artifact bindings and stored results; it does not rerun Z3 or the fixtures. Fresh reproduction outputs have fresh timing and hash metadata. The stored `protocol.json`, `model.json`, `runtime.json` and `verification.json` remain separate immutable evidence.
