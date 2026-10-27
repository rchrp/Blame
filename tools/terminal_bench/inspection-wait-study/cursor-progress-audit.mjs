// Preserve rendered-output counters; interpret raw cursor progress separately.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {study} from './inputs.mjs';
import {atomicJson} from '../durable-campaign.mjs';
const original=JSON.parse(await readFile(join(study,'inspection-audit.json')));
const trials=original.trials.map(t=>{
 const inspections=t.inspections.map(i=>({...i,rawCursorProgress:i.inputCursor!==null&&i.returnedCursor!==null?Number(i.returnedCursor)-Number(i.inputCursor):null,emptyPresentedOutput:i.outputBytes===0}));
 return {name:t.name,arm:t.arm,inspections,emptyRunningWithoutCursorProgress:inspections.filter(i=>i.process==='running'&&i.emptyPresentedOutput&&i.rawCursorProgress===0).length,emptyRunningWithRealCursorProgress:inspections.filter(i=>i.process==='running'&&i.emptyPresentedOutput&&i.rawCursorProgress>0).length};
});
await atomicJson(join(study,'cursor-progress-audit.json'),{executionFinished:original.executionFinished,trials,boundary:'The byte cursor measures the raw captured stream. The displayed output has redaction and trim, so an empty displayed string can coexist with real progress, e.g. one newline byte. Preserve both observations; do not call this fabricated progress, missing execution or an unchanged stream. This post-dispatch interpretation does not change a model input or score.'});
console.log('Separated rendered emptiness from raw stream progress for '+trials.length+' trials.');
