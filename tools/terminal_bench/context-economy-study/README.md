# F68 advice economy; F69 natural cross-module confirmation

Evidence: `docs/experiments/light-harness-context-economy-f68-2026-10-27`.
Selection precedes outcomes. F68 reuses two known diagnostic opportunities;
F69 uses two historical TanStack Query issues new to this study. Each has two
repetitions and rotated sequential arms. Do not pool task/SDK generations.

Only one treatment changes per Light arm:

| Arm | Repair context compaction | Literal filename matching |
| --- | --- | --- |
| reference | false | false |
| compact | true | false |
| navigation (F69 only) | false | true |
| cline | false | false |

These correspond to `BLAME_AGENT_REPAIR_CONTEXT_COMPACTION` and
`BLAME_AGENT_LITERAL_FILE_SEARCH`. Compiler-first advice is common to Light;
optional symbolic analysis/hints are off. Tool schemas and first Light prompts
must match; the post-dispatch mechanism audit checks that boundary.

Local controls, without external model requests:

```sh
node --test tools/terminal_bench/context-economy-study/*.test.mjs
node tools/terminal_bench/context-economy-study/sdk-controls.mjs
node tools/terminal_bench/context-economy-study/local-replays.mjs
```

The SDK control exercises actual ClineCore/tool execution through loopback HTTP:
full plan, duplicate, explicit ledger read; checks exact observed metadata,
prefix stability and failed-check truth. Local replay reports serialized bytes,
not tokens. The old sealed executable checks the flag-off reference.

This coordinator uses fixed research paths under `/workspace/blame-study-runs/context-f68`;
it is not a general benchmark CLI. A fresh campaign first prepares the pinned
F63 diagnostic dependencies and both pinned natural-project dependency trees,
archives the selected upstream parents without solution history, and installs
immutable `.study` adapters (`inputs.mjs`). `controls.mjs` verifies that official
patches and independently authored probes fail on the unmodified source and pass
with the upstream production fix. The React setup is preserved; Vite uses its
native config loader and writes caches to ignored reports.

`campaign.mjs freeze` binds compiled runtime, SDK/provider bytes, dependencies,
inputs, graders, official patches, observers, settings, prompts and budgets before
external requests. Commit and push that protocol first. Each `campaign.mjs run`
starts **at most one new model trial** in a fresh process. Retain every exit and
checkpoint; never retry an uncertain invocation or overwrite bound artifacts.
Check access/budget stop records before continuing. Do not build, run development
tests or execute solvers alongside measured workers.

Four required invocations are audited identically for both harnesses: literal
immutable npm script, observed success, unchanged source fingerprints at launch
and completion, no masking or collector wrappers. An asynchronous inspection must
retain the original launch provenance. This audit is separate from formal runtime
admission, and unsupported Vitest 4/5 reporting stays unknown. Independent source
grading restores supplied tests/configuration and runs official tests plus finite
probes in a separate production-only tree; model-authored tests are also checked.

After dispatch, `readout.mjs`, `mechanism-audit.mjs` and `time-audit.mjs` only read
immutable checkpoints and produce derived reports. Raw, source and audited success
remain separate. Resource totals retain failures and nulls, with paired estimates
on jointly audited successes and pair/task omissions. Cache reads are an input
subset. SDK USD estimates are not invoices or euro conversions. Passive source
observation overhead and unfinished HTTP spans are explicit. Request-boundary
receipts establish forwarded context, not attention or useful model reasoning.

After all workers exit, `archive-inputs.mjs` exports a shared Git bundle of only
the four original input commits, exact frozen compiled runtime, official patches
and per-task dependency locks. `replay.mjs --portable` restores those original
commits, applies each unchanged archived model patch, verifies the exact final
source fingerprint, and repeats the independent endpoints. Restore the pinned
dependency directories first. Replay uses the frozen Linux permission convention
(`umask 077`); it is not a cross-platform fingerprint claim. It retains mismatches
and never repairs or retrieves a solution. The `inputs` archive is published only
after model dispatch, so hidden official/probe information is not a worker input.
