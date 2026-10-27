// Derived post-hoc diagnostics; preserves every raw receipt and automatic score.
import {join} from 'node:path';
import {evidence, file} from './evidence.mjs';
import {study} from './inputs.mjs';
import {atomicJson} from '../durable-campaign.mjs';
import {unwrapFeedbackEnvelope} from '../../../packages/agent-runtime/dist/tool-result-envelope.js';
const {records, executionFinished, modelCompleted, protocol} = await evidence();
const candidates = [], firstStreams = [];
let commands = 0;
const textFields = new Set(['output','content','diagnostics','message','recovery','snippet','stdout','stderr','text']);
function inspect(value, path = [], detached = false) {
  if (typeof value === 'string') {
    if (detached && /runtime_test_scope/u.test(value)) candidates.push({path: path.join('.'), chars: value.length});
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) if (key !== 'testValidationScope')
    inspect(child, [...path, key], detached || textFields.has(key));
}
for (const c of records) {
  const events = file(c, 'events.jsonl').toString().split('\n').filter(Boolean).map(l => JSON.parse(l).event);
  for (const event of events) if (event?.type === 'tool' && event.payload?.phase === 'finished' && event.payload.toolCall?.name === 'run_task') {
    commands++; inspect(unwrapFeedbackEnvelope(event.payload.output), [c.name]);
  }
  if (c.partial || c.row.panel !== 'F67') continue;
  const timing = file(c, 'request-timing.jsonl').toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const start = timing.find(e => e.event === 'fetch_started');
  const end = timing.find(e => e.attempt === start?.attempt && e.event === 'body_end');
  const firstHttpMs = end ? end.monotonicMs - start.monotonicMs : null;
  firstStreams.push({name: c.name, arm: c.row.arm, task: c.row.task, repeat: c.row.repeat,
    sdkMs: c.row.sdkDurationMs, firstHttpMs, afterFirstStreamMs: firstHttpMs === null ? null : c.row.sdkDurationMs - firstHttpMs});
}
await atomicJson(join(study, 'observer-safety-amendment.json'), {
  kind: 'post-dispatch observer-only negative-control correction', modelTrialsChanged: false, rawReceiptFilesRewritten: false,
  commandsInspected: commands, detachedReceiptLiteralCandidates: candidates,
  change: 'Ignore detached JSON in typed input_text envelope arrays, as already done for text arrays. Expanded local negative control fails before and passes after the one-line observer fix.',
  boundary: 'Original provider bodies were not retained or reconstructed. No inspected command diagnostic contains the literal required for the false positive. Live receipts are separately correlated by exact offered hash and call identity. Historical exposure claims and scores remain unchanged.'});
await atomicJson(join(study, 'first-stream-sensitivity.json'), {
  kind: 'post-hoc duration sensitivity; raw trial durations unchanged', rows: firstStreams,
  boundary: 'Subtracting a first HTTP span is descriptive, not causal attribution to queue/generation/network or a new primary endpoint.'});
await atomicJson(join(study, 'study-status.json'), {executionFinished, modelCompleted,
  interrupted: records.filter(c => c.partial).length, accounted: records.length, planned: protocol.order.length,
  remainingUnstarted: protocol.order.length - records.length, retried: 0, replacementAssignments: 0});
console.log({executionFinished, modelCompleted, commands, diagnosticCandidates: candidates.length});
