# F48: bounded declaration discovery and test-type diagnostics

Two independently tested mechanisms address observations from F43–F45. No F48 model comparison is claimed.

| Mechanism | Evidence | Limitation |
| --- | --- | --- |
| Exact declaration candidates behind saturated lexical references | Constructed replay needs 15 versus 12 researcher navigation calls | Feedback rises 17.4%; timings overlap local tests; no model-token claim |
| Distinct same-file declaration aliases | A newly exposed pre-existing reuse defect is corrected; ambiguous stale identities are refused | Identity discovery remains bounded syntax, requiring explicit selection |
| Vitest type diagnostic | Real runtime pass despite TS2322; explicit typecheck suite fails even with “Type Errors no errors” | Delivered-file typecheck selection remains unknown; no scope admission |

`navigation/` and `type-evidence/` contain separate raw receipts, procedures and adverse development findings. `local-validation.json` binds source files and compressed verification logs. Final integrated runtime: **1,020 passed, two skipped, zero failed**. Runner: **37/37**. Standalone payload: **3/3**. Changed runtime ESLint and repository line budgets pass.

The earlier full run has two failures caused by incorrect assertions in newly written navigation tests, before correction; a first overload fixture also assumed function signatures were indexed when only the implementation was indexed. These outcomes are retained. The actual alias-collision defect is separate from those test mistakes. The final combined suite includes the corrected regressions.

F47 measures the earlier F45 selection correction alone on frozen snapshots excluding these changes. F50 uses F48 in both Light arms and isolates optional symbolic-analysis exposure. Neither comparison isolates the model effect of F48 navigation or type diagnostics; that remains a future experiment.
