# F50: optional symbolic reasoning exposure

**No Z3 reasoning benefit is demonstrated.** All eighteen assignments completed, but no agent called `analyze` or the solver directly. Candidate Light’s higher registered audited score depends entirely on an ambiguous helper requirement, while its paired resource comparison with reference Light is adverse. Keep analysis optional and off by default.

## Frozen comparison

Three new constructed multi-file integer-policy requests—credit allocation, inclusive tier accounting and signed window overlap—were selected before results, with two rotated repetitions and three arms. All arms use snapshot `12166e172e16c6addf194e25a3b2999a04257505`. Reference/candidate Light differ only through the symbolic feature flag and resulting tool exposure. Candidate schema size is **12,278 versus 10,473 bytes (+1,805)**. The same Z3 binary/libraries and explicit `"$BLAME_Z3_PATH"` command are available to every arm; bare `z3` availability is not promised.

`protocol.json` and `execution-bindings.json` pin `openai-codex / gpt-5.6-luna / high`, prompts/schemas, code, dependencies and environment. Per-assignment copied dependencies/offline caches are isolated. Limits: 0.50 USD SDK soft cap +0.25 reserve, 600 seconds +25 watchdog, 40 iterations, 8,192 output tokens, 500,000 request bytes; panel stop 20 USD. No retries, forced analysis call or supplied model assertion. Pristine/positive/mutant controls discriminate requested behavior; hidden oracles/reference patches never enter worker inputs.

## Registered outcomes and interpretation

All-assigned totals include registered failures. Scores retain the unchanged registered public-helper interpretation.

| Arm | Official | Selected | Independent | Strict audited | Tokens | SDK USD | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Light, flag off | 6/6 | 6/6 | 5/6 | 5/6 | 442,954 | 0.05185676 | 443.4 |
| Light, flag on | 6/6 | 6/6 | 6/6 | 6/6 | 521,734 | 0.05895280 | 459.2 |
| Integrated Cline | 6/6 | 6/6 | 4/6 | 4/6 | 546,832 | 0.07016148 | 336.4 |

Original regression, source compilation and delivered-test runtime selections pass throughout; added tests also compile independently. Those selections do not establish the full request. Both Cline tier repeats and reference repeat 2 leave exported `tierCost` unchanged: `tierCost(1,0,-1,2)` returns -1 instead of the oracle’s registered 0. Their named `quoteTierUsage` consumer correctly normalizes rates.

The instruction names that consumer immediately before “Normalize negative rates to zero”; direct `tierCost` normalization is not explicitly required. A consumer-only reading is plausible. A uniform **post-hoc manual sensitivity** finds all six tier endpoints correct under that narrower reading, removing the apparent quality gap. Separate executable replay confirms all six on its finite domain, **18,179 assertions per endpoint**, with unchanged source hashes. Requested after sixteen completed assignments/fifteen reviewed and registered after all eighteen, this diagnostic changes no primary score or agent success. See `interpretation-notes.json`, `interpretation-sensitivity.json`, `interpretation-replay-results.json` and `source-review.json`.

## Resources and mechanism

On five strict candidate/reference pairs, candidate uses **+15.8% tokens, +12.9% estimated cost, +2.2% duration**. Token differences remain +5.8% to +32.4% leaving one pair out, but range -9.0% to +32.4% leaving one task out. On four strict candidate/Cline pairs, candidate uses **+4.3% tokens, -12.7% cost, +60.6% duration**; leave-one-pair token differences range -1.7% to +18.5%. The resource gate fails. All-assigned totals have unequal primary audited quality and do not establish efficiency at parity.

Actual optional calls, direct solver command trials and meaningful symbolic uses are all **zero**. Schema exposure is verified, but no computational benefit can be attributed to solver use. Ordinary traces retain corrected agent-generated test expectations, relative-import errors and recoverable edit-target mistakes; these are not solver discoveries.

All **149 forwarded attempts have 149 usage receipts**; input/output and SDK-cost observations reconcile. Reported cache reads—336,128/384,000/406,144 for reference/candidate/Cline—are included in input. Per-request cache accounting does not reconcile; aggregate cache-write zero does not prove no writes. New SDK estimate: **0.18097104 USD**, no new reserve. Cumulative recorded studies: **8.38491180 USD observed +3.64 historical reserves =12.02491180 accounted**. These are estimates/reserves, not invoices; hidden retries, provider revision, researcher/host/audit costs and external contention remain unknown.

## Separate local symbolic diagnostic

`endpoint-symbolic.json` is a known **post-hoc** diagnostic, selected after seven assignments and registered with eleven outcomes available. Uniform researcher-supplied queries on all eighteen unchanged endpoints produce **24 analyses: eighteen bounded-no-counterexample, three unknown, three counterexamples**. Unknowns preserve natural valid solutions containing unsupported `Math` calls. All three witnesses reproduce in isolated actual TypeScript/JavaScript; source/check hashes remain unchanged.

Every counterexample is the known, interpretation-sensitive helper case: e.g. `tierCost(3,1,-3,-1)` produces -10 where the isolated normalized-rate property expects 0. This adds no model success or indisputable new user-visible bug. Witness replay isolates the original function body and establishes no cross-file integration. Bounded absence concerns only the supplied scalar property/domain. The result supports the local capability, not general semantic reasoning or default exposure.

## Reproduction

Publication/artifact verification is complete. **All eighteen unchanged patches reproduce their five original endpoint outcomes**, including the three registered hidden-oracle failures: matching results are not eighteen passing tasks. Restore pinned inputs/dependencies as described in the tools README; these model-free commands refuse existing replay outputs:

```sh
node tools/terminal_bench/symbolic-reasoning-model-study/verify.mjs
node tools/terminal_bench/symbolic-reasoning-model-study/replay.mjs --output=/tmp/f50-endpoint-replay-new.json
node tools/terminal_bench/symbolic-endpoint-diagnostic/replay.mjs --workers-complete --output=/tmp/f50-symbolic-new.json
node tools/terminal_bench/symbolic-endpoint-diagnostic/interpretation-replay.mjs --output=/tmp/f50-consumer-new.json
```

Registered results, compressed traces and accounting remain separate from the post-hoc diagnostics. These small synthetic requests favor a restricted integer subset; independent tasks/projects and explicit helper contracts are needed before broader conclusions.
