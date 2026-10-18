# F55: separate durable discovery diagnostic

Known F50/F52 constructed tasks, two dependent repeats, three arms, 18 assignments. This campaign follows F52 evidence loss; it does not replace those missing trials or count as fresh confirmation. All inputs were frozen before F55 calls. Both Light arms expose the same analysis schema and Math-capable engine; only body-read hints differ. Cline uses its integrated SDK and the same ordinary solver access. No property or forced analysis is supplied.

| Arm | Strict audited | Tokens | SDK estimate USD | Seconds |
|---|---:|---:|---:|---:|
| Light, hints off | 6/6 | 599,297 | .057277 | 278.1 |
| Light, hints on | 6/6 | 582,833 | .064619 | 295.4 |
| Integrated Cline | 6/6 | 488,219 | .072919 | 296.1 |

Official, selected, independent and strict success all agree here. Sixteen hints are emitted, none followed by analysis; there are no analyze or direct solver calls. Relative to reference, candidate tokens fall 2.7%, SDK cost rises 12.8%, duration rises 6.2%. Leave-pair-out token changes range −13.9% to +10.4%; leave-task-out −22.0% to +16.9%. Relative to Cline, candidate uses 19.4% more tokens, estimates 11.4% less SDK cost and has essentially equal duration (−0.2%). Fewer tokens and lower cost are distinct observations.

All 157 forwarded attempts have receipts. Per-request cache attribution does not reconcile with SDK aggregates in any arm; reported zero writes is not measured absence. New SDK estimates total USD.1948144. The cumulative ledger retains USD8.5797262 observed plus USD17.14 reservations, including lost F52 consumption; it is not an invoice.

The registered live recovery control pauses only after the first nine assignments. Their start/event/wire/patch/check/result hashes remain identical after resume, which starts the next registered assignment with zero repeated completed calls. One administrative pause affects overall wall time and may affect unobserved cache residency; per-trial durations remain original. The complete prefix is hash-bound in `live-resume-*.json`. Intermediate source/test/type failures remain archived and charged to each original trial.

Decision: retain durable execution and bounded local correctness, keep symbolic reasoning globally opt-in. Neither meaningful-use nor efficiency gate passes; there is no demonstrated benefit from discovery hints on this panel. This does not establish that reasoning can never help another task. Remeda navigation is measured separately in F53; no cohort pooling or solution recovery.

Reproduction: scripts in `tools/terminal_bench/symbolic-discovery-recovery-study`, frozen archives/locks/solver identity in this directory. Raw checkpoints are published after each trial; final traces, manual source/delivery review and independent arithmetic verification are retained separately. Endpoint replays check unchanged patches, not new model successes.
