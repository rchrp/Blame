# Bounded Vitest typecheck diagnostics

These local controls use Vitest 3.2.4 and TypeScript 5.9.3, with copied dependencies and no model requests. They extend the known F45 type-selection diagnostic; they are not fresh model tasks or evidence of higher task success or token savings.

The same `*.test.ts` contains an intentional TS2322. Default Vitest runtime selection passes one case and prints `Type Errors no errors`; direct `tsc` exits 2. A custom Vitest typecheck selection includes that file and exits 1 with a `TypeCheckError` suite, **still printing `Type Errors no errors`**. That heading counts failing typecheck cases and can omit suite-level errors.

The new optional diagnostic records explicit CLI requests/suppression and bounded reported text. File selection remains `unknown`; contradictory suite-error output makes the heading's error report unknown. Runtime counts, process exit, selection, freshness and source admission keep their existing meanings. No additional commands, automatic expansion or new completion gate are introduced. Unsupported versions, ambiguous commands, interruptions and duplicate summaries remain unknown. Ordinary Vitest invocations without typecheck flags/heading receive no extra object.

Source-loader unit checks: 18 passed, including malformed/mixed counters, conflicting summaries, custom config, unsupported version, cancellation and stale source. Narrow ESLint passed. Integration build and full suite are recorded by the parent F48 study.

Reproduce from repository root (use a new output path):

```sh
node --import ./.blame/research/validation-scope-f44/dependencies/node_modules/tsx/dist/loader.mjs tools/terminal_bench/test-type-evidence-study/replay.mjs packages/agent-runtime/src/harness/check-observation.ts .blame/research/validation-scope-f44/dependencies /tmp/new-type-evidence-controls.json
node tools/terminal_bench/test-type-evidence-study/verify.mjs /tmp/new-type-evidence-controls.json
```

The dependency root must contain the exact published F44 npm dependency lock installation. The replay records code/fixture hashes, versions, full outputs, exit statuses and durations; outputs cannot be overwritten. Its first development run incorrectly expected Vitest to print the numeric `TS2322` code; Vitest prints `TypeCheckError` instead. That failed assertion prompted the contradictory-heading control above. No model result or benchmark trial was omitted.
