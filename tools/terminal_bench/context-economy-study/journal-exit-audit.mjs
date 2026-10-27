// Post-hoc diagnostic: journal evidence supplements, never rescales, frozen scores.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {evidence,file} from './evidence.mjs';
import {study,work} from './inputs.mjs';
import {atomicJson,atomicWrite,digest} from '../durable-campaign.mjs';

const {records,executionFinished,protocolHash}=await evidence();
assert.equal(executionFinished,true);
const extract=`import tarfile,json,sys
rows=[]
with tarfile.open(sys.argv[1]) as arc:
 for m in arc:
  if m.isfile() and m.name.startswith('./.blame/harness/light/') and m.name.endswith('.jsonl'):
   rows.append({'path':m.name,'text':arc.extractfile(m).read().decode('utf-8')})
print(json.dumps(rows))
`;
const raw=[],trials=[];
for(const c of records.filter(c=>c.row.arm!=='cline'&&!c.row.requiredInvocationsReported)){
 const archivePath=join(work,'campaign',c.name,'workspace.tar.gz');
 const archive=JSON.parse(file(c,'workspace-archive.json'));
 assert.equal(digest(await readFile(archivePath)),archive.sha256);
 const journals=JSON.parse(execFileSync('python3',['-c',extract,archivePath],{encoding:'utf8',maxBuffer:20*1024*1024}));
 const events=journals.flatMap(j=>j.text.split('\n').filter(Boolean).map(l=>JSON.parse(l)));
 const tools=JSON.parse(file(c,'tool-ledger.json'));
 const required=new Set(c.row.requiredEvidence.map(r=>r.command));
 const validations=events.filter(e=>e.type==='validation'&&required.has(e.command));
 const incompleteSnapshots=tools.filter(t=>t.tool==='run_task'&&required.has(t.output?.data?.command)&&t.output.data.process==='exited'&&!t.output.data.completed).map(t=>({callId:t.toolCallId??t.toolCall.id,timestamp:t.timestamp,run:t.output.data.run,command:t.output.data.command,process:t.output.data.process,hasExitCode:typeof t.output.data.exitCode==='number',nextJournalValidation:validations.find(v=>v.command===t.output.data.command&&v.timestamp>=t.timestamp)??null}));
 raw.push({name:c.name,checkpointSha256:c.receipt.sha256,workspaceArchiveSha256:archive.sha256,journals:journals.map(j=>({...j,sha256:digest(j.text)}))});
 trials.push({name:c.name,frozenRequiredEvidence:c.row.requiredEvidence,finalSourceSha256:JSON.parse(file(c,'source-at-exit.json')).sha256,journals:journals.map(j=>({path:j.path,sha256:digest(j.text)})),requiredValidations:validations,incompleteSnapshots,terminal:events.filter(e=>e.type==='terminal').map(({type,state,timestamp})=>({type,state,timestamp}))});
}
const bytes=gzipSync(JSON.stringify({protocolHash,trials:raw})+'\n');
await atomicWrite(join(study,'journal-exit-evidence.json.gz'),bytes);
await atomicJson(join(study,'journal-exit-audit.json'),{protocolHash,complete:true,selected:'All completed Light assignments with missing frozen required-execution evidence; selected after outcomes, not a new success endpoint.',evidenceSha256:digest(bytes),trials,boundary:'Original journals extracted without source changes from local archives whose SHA-256 is authenticated by the published immutable checkpoints. Full extracted journal bytes are retained here; reproducing archive membership also requires the original private workspace archives. A journal zero exit, displayed runner counts, finalized tool result, admitted verification and user acceptance are separate facts. The primary tool-receipt/final-source score is unchanged; no automatic reinterpretation of journal source revision IDs as the independent source fingerprint.'});
console.log('Archived journal-only diagnostics for '+trials.length+' frozen Light failures; scores unchanged.');
