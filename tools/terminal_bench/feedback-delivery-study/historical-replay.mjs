import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {presentToolResults} from '../../../packages/agent-runtime/dist/tool-result-presentation.js';
import {feedbackReceipts} from './receipt-metadata.mjs';
import {scopeMetadata} from '../feedback-ablation-study/scope-observations.mjs';
const root=process.env.BLAME_F64_ARTIFACT_ROOT??'/workspace/blame-study-runs/feedback-f64/campaign';
const {readdir}=await import('node:fs/promises'),trials=[],sha=v=>createHash('sha256').update(v).digest('hex');
for(const name of (await readdir(root)).filter(n=>n.endsWith('-candidate')).sort()){
 const bytes=await readFile(join(root,name,'tool-ledger.json')),ledger=JSON.parse(bytes),offers=[];
 for(const tool of ledger){
  let output=tool.output;try{if(typeof output==='string')output=JSON.parse(output);}catch{continue;}
  if(!output?.data?.testValidationScope)continue;
  const id=tool.toolCallId??tool.toolCall?.id,history=[{role:'assistant',content:[{type:'tool_use',id,name:'run_task',input:tool.input}]},{role:'user',content:[{type:'tool_result',tool_use_id:id,content:JSON.stringify(output)}]}];
  const raw={messages:history},presented={messages:presentToolResults(history)};
  const old=scopeMetadata(presented),next=feedbackReceipts(presented),expected=feedbackReceipts(raw);
  offers.push({scopeSha256:sha(JSON.stringify(output.data.testValidationScope)),oldObserverRecognized:old.length,formattedRecognized:next.length,exact:JSON.stringify(next)===JSON.stringify(expected)});
 }
 trials.push({trial:name,ledgerSha256:sha(bytes),offers});
}
const result={kind:'local_shape_replay_not_historical_network_reconstruction',externalModelRequests:0,trials,offers:trials.reduce((n,t)=>n+t.offers.length,0),oldRecognized:trials.reduce((n,t)=>n+t.offers.reduce((s,o)=>s+o.oldObserverRecognized,0),0),newRecognized:trials.reduce((n,t)=>n+t.offers.reduce((s,o)=>s+o.formattedRecognized,0),0)};
const output=process.env.BLAME_STUDY_CONTROL_OUTPUT;if(output){await mkdir(join(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({offers:result.offers,oldRecognized:result.oldRecognized,newRecognized:result.newRecognized,allExact:trials.every(t=>t.offers.every(o=>o.exact)),boundary:result.kind}));
