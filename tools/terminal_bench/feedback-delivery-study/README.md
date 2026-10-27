# F65 delivery controls; isolated F66/F67 model panels

Selection and scoring criteria were registered before model requests. F65 is a
local transport test, F66 tests opt-in grouped reads, and F67 tests literal
no-emit compiler recovery. The common F65 fix is present in both Light arms.
SDK 0.2.0 results must not be pooled with historical SDK 0.0.82 campaigns.

Evidence is in `docs/experiments/light-harness-feedback-delivery-f65-2026-10-27`.
`model-protocol.json` binds source, compiled executables, SDK/provider bytes,
inputs, dependencies, prompts, settings, assignment order and budgets. Immutable
checkpoints contain tool ledgers, patches, outputs and request metadata; they
exclude credentials and raw request bodies. Unknown consumption stays unknown.

Local controls (no external model):

```sh
node --test tools/terminal_bench/feedback-delivery-study/*.test.mjs
node tools/terminal_bench/feedback-delivery-study/historical-replay.mjs
node tools/terminal_bench/feedback-delivery-study/sdk-controls.mjs
BLAME_STUDY_ENVELOPE=true node tools/terminal_bench/feedback-delivery-study/sdk-controls.mjs
node tools/terminal_bench/feedback-delivery-study/native-controls.mjs
```

For a fresh campaign, build the runtime and runner and restore the pinned F63
dependency lock/tree and F64 RxJS archive first. `inputs.mjs` creates inputs once,
then `controls.mjs` checks positive implementations and behavioral mutants outside
model workspaces. `campaign.mjs freeze` refuses to overwrite executable bindings.
Commit its protocol before `campaign.mjs run`. The driver uses `/workspace/blame-study-runs/feedback-f65`
and refuses to retry a started trial without a known exit. Do not reuse those
paths for another campaign or run development builds/tests alongside live workers.
This is a research coordinator with fixed cloud paths, not a general benchmark CLI.

After dispatch, `readout.mjs` and `mechanism-audit.mjs` only analyze checkpoints.
`replay.mjs --portable` uses the published shared Git bundle of original input
commits, requires all workers to have exited, reconstructs each unchanged
model patch from the original input, checks exact final-source hashes, then
repeats the five frozen endpoints against immutable checks. It never retrieves
or repairs a solution. The published `inputs` directory retains original input commits, exact compiled
runtime outputs and both dependency locks. Restore the F63 dependency directory
from `dependencies-package.json` / `dependencies-package-lock.json` using npm
11.6.4 before replay. Replay verifies original Git identities and every final
source hash, without relying on platform-dependent original tar metadata.

Compare official, source and strict success separately. Native check recognition
is deliberately limited to successful literal npm invocations on final source;
unrecognized syntax is unverified, not a demonstrated failed invocation. Resource
comparisons include all assignments plus jointly strict pairs and omissions.
Cache is an input subset; SDK cost is an estimate, not an invoice. The source
observer's overhead is explicit. Receipt forwarding proves neither attention nor
use, and offering an unused batch does not validate its intended mechanism.

The original coordinator was killed during assignment nine. Eight completed
checkpoints, its incomplete capture and fifteen unchanged continuation assignments
are retained separately. The continuation binds the same executables and runs one
new trial per process; it never retries the unknown trial. `readout.mjs` accounts
for all 24 assignments and leaves unknown aggregate tokens/cost/duration null.
`manual-readout.mjs` is an explicitly post-hoc child-status/source-order evidence
sensitivity; the frozen automatic scores remain unchanged. Grouped reads had no
use in four trials and were removed from production; the experiment remains in
commit history and the frozen runtime archive.
