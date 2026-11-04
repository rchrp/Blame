# F31 evidence and decisions

The public issues motivate the features; the API details, allowlist, UTF-16/clone
and callback-error criteria are researcher specifications disclosed to every arm.
These are two new project/feature instances with dependent repeats, not official
upstream judgments or a representative large-repository sample. See
[protocol.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/protocol.json), [corpus-scope.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/corpus-scope.json) and
[report.md](report.md) for the fixed selection, scope and numerical results.

## Diagnosis against current implementation

| Observation | Original evidence | Current status and interpretation |
|---|---|---|
| Repeated whole-symbol replacements accumulate the existing indentation before the AST boundary. | F30 `2-commander-canonical-choices-candidate`, three original symbol-edit batches; [runtime-controls.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/runtime-controls.json) replays them against both frozen runtimes. | Fixed locally in `light-edit.ts`: old first-line indentation 2→4→6, candidate 2→2→2. Only an exact matching JS/TS/JSX/TSX leading prefix is removed once; later bytes stay exact. This is a known-input replay, not a new successful model task. |
| A model attaches a symbol target to a multi-file patch, then repairs its request after refusal. | F31 YAML R3 baseline calls22–23; fast-glob R2 candidate41–43. Full tool inputs and refusal details are in [tool-ledger.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/tool-ledger.json). | Current scope/atomicity guards work. The existing recovery explains the explicit file route; adoption still costs calls. No automatic widening was added. |
| Dependency navigation refuses files needed to understand callback exceptions; the agent repeats the request, then uses shell inspection. | fast-glob R2 baseline22–31 and candidate24–31; corresponding messages explicitly exclude dependency internals. | Still present by design in navigation. Installed dependency bytes are accessible through `run_task`; this is navigation friction, not an unavailable environment. Precise read-only declaration access is a future hypothesis. |
| New feature tests pass while a prior unit test fails. | fast-glob R2 candidate: [original score](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/traces/2-fast-glob-dynamic-filter-candidate.score.json.gz), `ReaderStream.dynamic should call fs.walk method`; final `stream.ts` accesses the mock's undefined result. | A model implementation/regression and incomplete validation. Focused feature success does not establish original-suite success. No whole-symbol edit occurred, so the changed indentation code is not an observed mediator. |
| Dependent commands are submitted to a concurrent native tool. | YAML R2 Cline call12; focused command fails `MODULE_NOT_FOUND` before the build completes. The native schema explicitly says commands execute concurrently and must be independent: [wire-contracts.json.gz](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/wire-contracts.json.gz). | Model tool misuse, not a missing concurrency contract. The exact required focused invocation is never successfully repeated; a later shim is not an equivalent recorded invocation under the fixed criteria. Independent build-first grading succeeds. The final layout diagnosis is unsupported. |
| Correct commands/source coexist with an incorrect final count attribution. | fast-glob R2 Cline call22 and final delivery: 1,350 passing /9 pending are assigned to `npm test`, whose actual unit result is246 passing; these are E2E counts. | Native bounded presentation and model interpretation need separate investigation. Primary full acceptance fails; [reporting-only-sensitivity.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/reporting-only-sensitivity.json) relaxes only this factual delivery failure. F32 tests an isolated Light presentation prototype and cannot be credited with repairing this native trajectory. |
| A project task executes its resolved script directly, not an exact npm wrapper. | YAML R1 baseline27/29, R2 candidate28/30, R2 baseline30/32 and R3 candidate29/31: recorded commands are `rollup ...` and `tsc ...`, while the fixed instruction requires literal `npm run ...`. | Current behavior is explicit in the returned `command`. Exact-invocation acceptance fails even though the underlying validations and final sources pass. Npm lifecycle/environment semantics are not silently equivalent. This is separate from native concurrency misuse. |
| A temporary forbidden source edit disappears from the final diff. | fast-glob R1 candidate40–41 and R2 candidate45–46 write then revert `src/readers/sync.ts`. | Task action scope is stricter than endpoint scope. Retain primary failures. The post-selected [final-scope-only-sensitivity.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/final-scope-only-sensitivity.json) relaxes only a scope-only case, never failed behavior/checks or missing delivery. |
| Iteration exhaustion and the research request-byte guard stop different runs. | [failure-classification.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/failure-classification.json) binds exact original errors; R1 glob baseline reaches32 iterations, R1 Cline rejects314,265 bytes before dispatch against290,000. | These are configured study-runner limits,not universal production harness caps or an established provider context limit. Missing delivery and all consumed resources remain. A passing independent endpoint does not recover runtime success or final-source agent validation. |

One free-text audit note initially misattributed R1 glob baseline's stop to the
byte guard; its correction changes no grade. More materially, initial review
incorrectly counted resolved project scripts as the exact requested npm wrappers
in four YAML trials. Exact-check/full-acceptance judgments are corrected to false;
original successful behavior and model outcomes remain. Both old and corrected
decisions, original command bindings, instruction/event/diff/score hashes remain
in [review-corrections.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/review-corrections.json). Earlier published prefix
summaries precede this correction; use the final18-trial report. The separate
post-selected [resolved-project-sensitivity.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/resolved-project-sensitivity.json)
shows the more permissive interpretation without changing the primary gate.

## At most three prioritized hypotheses

1. **Edit boundary correctness.** Removing a repeated existing first-line prefix
   should stabilize repeated whole-symbol replacement without changing bodies,
   signatures, exports, observation or atomic guards. Compare immutable runtimes
   on byte-exact controls/known replay, then the fixed F31 three-arm panel.
   Measure route exposure, unintended byte changes, full/behavioral acceptance
   and conditional resources. Risk: interpreting intentional first-line spaces;
   hence exact-prefix and language limits. Keep the bounded correctness repair;
   claim no model efficiency effect without exposure.
2. **Validation presentation.** Preserve detected raw aggregate lines omitted
   from long logs at the same character budget, with line locations and explicit
   non-verification labeling. F32 compares presentation only on all recorded
   Light log pointers plus controlled successful/failed commands. Measure lost
   versus visible observations, unchanged admission/count semantics, output size
   and local rendering CPU. Risks: reduced diagnostic context, extra scan work
   and overinterpretation of fragments. No F32 model adoption is measured.
   The direct-script/npm distinction and native command ordering need subsequent
   invocation-specific controls; preserving snippets alone does not fix them.
3. **Read-only dependency declarations.** Test a bounded explicit route to
   installed JS/TS declarations using configured compiler resolution. Compare
   existing shell fallback with otherwise identical navigation on preregistered
   new cross-file/dependency tasks; measure repair calls, correct identity,
   audited acceptance and resources. Keep edits/protected paths unchanged.
   Risks: more context, confusing dependency/source versions and accidental
   scope expansion. This remains a proposal, not implemented or measured here.

## Reproduction boundaries

The 18 assignments were selected before outcomes, rotated serially across arms,
and never replaced or retried after failure. Every original outcome and missing
consumption remains. The candidate differs in one executable module; all actual
initial contracts and normalized prompts match between Light arms. See
[mechanism-exposure.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/mechanism-exposure.json), [schema-treatment.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/schema-treatment.json)
and [execution-bindings.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/execution-bindings.json).
Actual preregistration uses the launch-bound repository commit/time, before the
first model start. The protocol's fixed `taskInputCommitAtUTC` is a configured
study-date label, not an observed commit timestamp; per-trial `gitHead` names the
isolated workspace initial commit. See [registration-audit.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/registration-audit.json).

`verify-public.py` checks public original bytes, usage/cache arithmetic, original
settings, manual-decision bindings, actual validation provenance, stop causes,
sensitivity arithmetic and decision gates. Corruption controls exercise those
checks. This is not independent re-adjudication of the unblinded researcher review.
`replay-public-behavior.mjs --full` separately reconstructs original source
endpoints and repeats builds, frozen UTC/supplied probes, types and original
unit/E2E suites; matching a known failure is successful reproduction, not task
acceptance. Non-UTC original outcomes remain in the scored records.

No benchmark population superiority, exhaustive correctness, large-project
token efficiency, or exhausted improvement margin follows from this panel.
The registered quality/resource gates fail and remain failed. The subsequent
[quality-investigation.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/quality-investigation.json) traces the adverse
endpoint to the model's stream patch and confirms the changed whole-symbol route
is absent from all12 Light trajectories. Retain the bounded indentation
correctness fix on its local byte/guard evidence; reject a model optimization
claim. This investigation neither removes the adverse outcome nor establishes
population noninferiority.
F32's complete recorded-log replay is neutral: all52 summary occurrences are
already visible in all17 logs,no view changes,and scan CPU increases by about
0.139ms/log. Its temporary integration is reverted despite positive constructed
controls. Keep that prototype isolated; it is not a further production improvement
or another successful model task.
