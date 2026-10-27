import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';
import {presentToolResults} from '../../../packages/agent-runtime/dist/tool-result-presentation.js';
import {pathMatches} from '../../../packages/agent-runtime/dist/harness/light-navigation.js';
import {atomicJson} from '../durable-campaign.mjs';import {work} from './inputs.mjs';
const baseline=await import(join(work,'frozen/reference-before/agent-runtime/dist/tool-result-presentation.js'));
const oldPaths=await import(join(work,'frozen/reference-before/agent-runtime/dist/harness/light-navigation.js'));
const previous=process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION,previousNav=process.env.BLAME_AGENT_LITERAL_FILE_SEARCH;
const reports=[];
try{
 for(const name of (await readdir('/workspace/blame-study-runs/feedback-f65/continuation')).filter(n=>n.endsWith('-compiler'))){
  const ledger=JSON.parse(await readFile('/workspace/blame-study-runs/feedback-f65/continuation/'+name+'/tool-ledger.json'));
  const messages=ledger.flatMap((t,i)=>[{role:'assistant',content:[{type:'tool_use',id:'call-'+i,name:t.tool,input:t.input}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call-'+i,content:JSON.stringify(t.output)}]}]);
  process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION='false';const ref=presentToolResults(messages);assert.deepEqual(ref,baseline.presentToolResults(messages));
  process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION='true';const projected=presentToolResults(messages);
  const refs=projected.flatMap(m=>m.content??[]).filter(b=>b.type==='tool_result'&&b.content.includes('repair_plan_reference')).length;
  reports.push({name,flagOffMatchesSealedReference:true,rawBytes:Buffer.byteLength(JSON.stringify(ref)),projectedBytes:Buffer.byteLength(JSON.stringify(projected)),references:refs});
 }
 const candidates=['packages/a/src/combineLatest.ts','packages/b/src/combineLatest.ts','packages/a/src/map.test.ts'];
 process.env.BLAME_AGENT_LITERAL_FILE_SEARCH='false';assert.deepEqual(pathMatches('test.ts',candidates),oldPaths.pathMatches('test.ts',candidates));
 process.env.BLAME_AGENT_LITERAL_FILE_SEARCH='true';const literal=pathMatches('test.ts',candidates);assert.deepEqual(literal,['packages/a/src/map.test.ts']);
 await atomicJson(join(work,'local-replays.json'),{externalModelRequests:0,knownDiagnosticReplays:reports,filenameReplay:{query:'test.ts',candidates,reference:oldPaths.pathMatches('test.ts',candidates),literal},limits:'Serialized model-context bytes, not tokenizer measurements. Historical transcript replay, not new task success.'});
 console.log(JSON.stringify(reports,null,2));
}finally{if(previous===undefined)delete process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION;else process.env.BLAME_AGENT_REPAIR_CONTEXT_COMPACTION=previous;if(previousNav===undefined)delete process.env.BLAME_AGENT_LITERAL_FILE_SEARCH;else process.env.BLAME_AGENT_LITERAL_FILE_SEARCH=previousNav;}
