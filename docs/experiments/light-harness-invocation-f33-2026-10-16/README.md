# F33 — truthful invocation display and review correction

Retain the display repair. It fixes misleading returned/journaled commands, not
npm execution: wrappers and lifecycle hooks were already preserved. No model-success,
token or cost gain follows from these local controls.

| Local evidence | Frozen old runtime | Fixed runtime |
| --- | ---: | ---: |
| Display matches actual spawned executable/argv | 0/3 | 3/3 |
| New regression controls | 1/3 | 3/3 |
| Observed lifecycle events | 6 | 6 |

The real-process probes cover build, custom typecheck and an instrumented Node
test with spaces in its filename. Separate controls preserve literal apostrophes,
substitution syntax, newlines and Unicode; raw commands remain exact. POSIX-style
quoting is diagnostic notation; execution still passes structured argv on every
platform. Catalog script definitions still identify the runner.

Compilation and lint pass. **578 current-source harness cases** yield **576 passes,
two skips, zero failures**. Stale compiled tests absent from source are excluded.
Replaying all 32 recorded successful F31 project-task labels reduces that field
from 797 to 495 UTF-8 bytes (21 shorter, 11 longer). This is command-label bytes,
not total output, billed tokens, model latency or a comparable-quality efficiency gain.
The initial research verifier failed to normalize identical reporters at different
runtime locations. Its repair is limited to report destinations and paths with equal
reporter hashes. This setup issue is separate from runtime regression results.

## Superseding F31 audit

My earlier claim that project tasks executed Rollup/tsc directly was wrong. Frozen
`taskInvocation` and `executeProjectTask` launch `npm run SCRIPT`; the returned
`command` sometimes showed the script definition. The local spawn audit confirms
this mechanism, including hooks. Historical invocations are **reconstructed from
frozen code and recorded inputs**, not historical spawn logs.

[corrected-f31-audit.json](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-invocation-f33-2026-10-16/corrected-f31-audit.json) supersedes that interpretation.
It retains four restored full-delivery judgments, a rejected check-only judgment,
a narrower failure reason, a note-only correction, all 18 rows, evidence hashes
and unchanged consumption. The exact-wrapper criterion is unchanged. Original F31
protocol, reviews, traces, source diffs, scores and F32 bindings remain untouched.

| F31 arm, six trials each | Official | Frozen endpoint | Exact final-source checks | Full audit |
| --- | ---: | ---: | ---: | ---: |
| Reference Light | 3 | 6 | 3 | 3 |
| Modified Light (indentation) | 4 | 5 | 3 | 3 |
| Integrated Cline SDK | 4 | 6 | 5 | 2 |

Three jointly accepted YAML pairs now qualify for the original strict comparison:
modified/reference tokens −5.0%, estimated cost +1.9%, worker time −10.7%. Both
registered gates still fail: the modified fast-glob endpoint retains its original
unit-test regression and the resource threshold is not reached. All 12 Light
trajectories still have zero exposure to the F31 whole-symbol change. Restored
acceptance is a reviewer correction, **not a harness improvement measurement**.
The frozen literal `npm test` requirement still differs from the actual `npm run
test` in two candidate glob trials. One formerly accepted check is rejected; the
other retains failure under this narrower reason. Both run npm lifecycle hooks.
Missing delivery, wrong check order, forbidden intermediate writes, native concurrent
dependent checks and factual count attribution remain failures.

## Reproduce

From the repository root with normal dependencies installed:

```sh
node packages/agent-runtime/node_modules/typescript/bin/tsc -p packages/agent-runtime
node tools/terminal_bench/invocation-study/local-replay.mjs
python3 tools/terminal_bench/invocation-study/verify.py
python3 tools/terminal_bench/invocation-study/publication-controls.py
node tools/terminal_bench/invocation-study/label-replay.mjs --verify
```

The replay reconstructs old modules from the public archive, preserving production
and private frozen runtimes. Seven corruption controls reject changed acceptance,
resources, quality, hooks, executable and admission. Python verifies recorded/manual
decisions and arithmetic; it does not independently adjudicate source behavior.
F31/F32 public verifiers still apply to their unchanged historical publications.

The direct API probe failed DNS; using the runner's `NODE_USE_ENV_PROXY=1` returned
HTTP 200. No missing-credential conclusion is drawn. The separately registered
[F34 known-task diagnostic](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-invocation-model-f34-2026-10-16/protocol.json)
isolates this display change in model runs; it is not fresh confirmation.
