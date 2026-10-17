# F50: optional symbolic reasoning model ablation

Preparation only; **no F50 model calls or agent-quality results yet**.

Three new constructed multi-file integer-policy requests are selected: capped credit availability/allocation, inclusive tier counts/costing, and signed half-open interval overlap with a shifted consumer. Two rotated repetitions compare reference Light, optional-Z3 Light and integrated Cline (18 planned assignments). One identical runtime snapshot is used; only the Light feature flag and resulting tool schema/description exposure differ. Every arm can access the same pinned local solver through the explicit ordinary command `"$BLAME_Z3_PATH"`; bare `z3` availability is not promised.

The local oracle controls are complete:

| Control | Original regression | Requested behavior | Source types | Added-test runtime | Added-test types |
| --- | --- | --- | --- | --- | --- |
| Pristine input, all three requests | Pass | Fail | Pass | Fail: none added | Fail: none added |
| Research positive patch, all three | Pass | Pass | Pass | Pass | Pass |
| Semantic mutation, all three | Pass | Fail | Pass | Fail | Pass |

The hidden oracle uses finite grids and independent operational checks: sequential credit deductions, enumerated closed-interval unit IDs, enumerated half-open unit cells, shifted consumers, large safe-integer examples and public type contracts. These checks are not an unbounded proof. Hidden oracles and positive patches never enter measured worker workspaces.

`oracle-controls.json` retains every local outcome and binds the fixture/task/oracle scripts. Positive patches are research controls only. Model registration, snapshot/environment checks, model results and endpoint replays are still pending root execution.

See `tools/terminal_bench/symbolic-reasoning-model-study/README.md` for exact freeze/run/audit/replay steps and the prespecified interpretation. Usage is optional, unsupported agent patches remain valid negative observations, solver absence of a counterexample grants no project validation, and schema/cache/token overhead counts in the comparison. These constructed tasks favor the supported scalar domain; they cannot establish general reasoning superiority.
