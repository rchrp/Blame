# Bounded declaration candidates for bare references

This is a local diagnostic study with no model requests. Bare reference searches previously derived their next searches from the first eight lexical results. A constructed file containing ten callers exhausts that window before the intended declaration in another file. The baseline then needs a separate symbol search. An ambiguity control already exposes both declarations through lexical results.

The candidate preserves lexical results and adds exact, case-sensitive JS/TS syntax declaration headers. Discovery visits at most 64 eligible scoped files, reads at most 1 MiB total and 256 KiB per file, and returns at most four declarations. Skipped files and limits remain visible. A current source revision and per-file hashes are checked before aliases are registered. Every subsequent semantic-reference query requires an explicit choice; discovery grants no edit coverage or validation admission.

Ordinary unambiguous headers retain readable `path#qualifiedName` next searches. Distinct indexed declarations sharing that qualified name use separate aliases. A pre-existing registry bug reused one alias for same-file homonyms; identity-based reuse now requires one matching declaration in current syntax, while exact current ranges still reuse their aliases. Stale ambiguous aliases refuse resolution and unique symbols retain their prior behavior. TypeScript function overload signatures are not individually indexed, while interface method overloads are. One new development test initially assumed three indexed function declarations and failed (actual one); a corrected valid interface fixture then exposed the actual alias collision. Both initial failure logs and the pre-guard replay remain visible.

The replay alternates frozen baseline and candidate over three repeats of two constructed fixtures, recording full feedback, serialized bytes, wall time, source/runtime hashes and compiler-reference follow-through. The researcher selects the intended declaration in both arms. These are dependent repeats of known diagnostics, not model success measurements. Feedback bytes are not provider tokens, and timing includes workspace/compiler startup while other local test suites ran concurrently. Larger initial feedback and bounded extra scanning are possible costs.

Across the six fixture executions per arm, the scripted route uses 15 baseline calls versus 12 candidate calls. Total serialized feedback rises from 21,552 to 25,302 bytes (+17.4%). The saturated case saves one discovery call per repeat; ambiguity already had a direct route and receives extra feedback. Recorded wall times are 8.63 s versus 8.35 s, with the concurrency limitation above; no duration improvement is inferred. Both arms reach the researcher's chosen compiler identity and preserve source bytes. No audited task success, provider-token or cost gain is established.

Reproduce from the repository root with compiled runtimes and a new output path:

```sh
node tools/terminal_bench/reference-candidate-study/replay.mjs BASELINE_DIST_HARNESS CANDIDATE_DIST_HARNESS /tmp/new-reference-candidates.json
```

Targeted tests cover saturation, ambiguity, exact/qualified names, scopes, declaration/file/byte limits, oversized and malformed sources, unsupported queries/languages, concurrent changes and unread/stale edit protection. Follow-up model experiments must measure whether agents use the choices and whether audited quality improves; scripted call reductions alone do not establish efficiency.
