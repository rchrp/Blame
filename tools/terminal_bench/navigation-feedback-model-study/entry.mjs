// F58 reuses the audited F53 coordinator/fixture; sealed F53 sources remain archived.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
process.env.BLAME_NAVIGATION_STUDY_ROOT='/workspace/blame-study-runs/navigation-feedback-f58';
process.env.BLAME_NAVIGATION_STUDY_OUTPUT=resolve(import.meta.dirname,'../../../docs/experiments/light-harness-navigation-feedback-f58-2026-10-18');
const action=process.argv[2];
assert.ok(['snapshot','controls','preflight-controls','environment-smoke','freeze','bind','run','resume','audit','publish','verify','replay'].includes(action),'Explicit supported phase required');
const file=['snapshot','freeze'].includes(action)?`./${action}.mjs`:
  `../navigation-large-model-study/${['bind','run','resume'].includes(action)?'run':action}.mjs`;
// The shared audit accepts optional positional roots. The wrapper phase is not
// such a root; keep the legacy driver's argv intact for run/bind/resume.
if(action==='audit')process.argv.splice(2,1);
await import(file);
