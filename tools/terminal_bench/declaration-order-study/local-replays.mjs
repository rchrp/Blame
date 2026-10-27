// Reproduce the observed bounded-scan failure; no external model calls.
import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {LightWorkspace} from '../../../packages/agent-runtime/dist/harness/light-workspace.js';import {work,tasks} from './inputs.mjs';import {atomicJson} from '../durable-campaign.mjs';
const {LightWorkspace:SealedWorkspace}=await import('/workspace/blame-study-runs/context-f68/frozen/model/agent-runtime/dist/harness/light-workspace.js');
const fields=['path','kind','qualifiedName','reason','lines','signature'];
function shape(result){assert.equal(result.status,'ok');const d=result.data,discovery=d.declarationDiscovery;return {results:d.results.map(r=>Object.fromEntries(fields.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))),candidates:(d.declarationCandidates??[]).map(r=>Object.fromEntries(fields.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]))),discovery:discovery?Object.fromEntries(Object.entries(discovery).filter(([k])=>k!=='sourceRevision')):null};}
const reports=[],previous=process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER;await mkdir(join(work,'local-replays'),{recursive:true});
try{for(const task of tasks){
 const root=await mkdtemp(join(work,'local-replays',task.id+'-'));execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',root]);
 const queries=task.id==='mutation-callbacks'?[{query:'onSettled',scope:'packages/query-core/src'},{query:'interface MutateOptions',scope:'packages/query-core/src'}]:[{query:'QueryFilters',scope:'packages/query-core/src',mode:'symbol'},{query:'isFetching',scope:['packages/query-core','packages/react-query'],mode:'text'}];
 const old=new SealedWorkspace(root,{sessionId:'sealed'}),current=new LightWorkspace(root,{sessionId:'current'});
 for(const input of queries){
  const query=input.query;
  process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER='false';const reference=shape(await old.searchCode(input)),disabled=shape(await current.searchCode(input));assert.deepEqual(disabled,reference,'Flag-off differs from sealed F69 implementation');
  process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER='true';const candidate=shape(await current.searchCode(input));
  assert.deepEqual(candidate.results,reference.results,'This treatment must not alter lexical/symbol result ranking');
  if(query==='interface MutateOptions'){assert.equal(reference.candidates.length,0);assert.ok(candidate.candidates.some(c=>c.qualifiedName==='MutateOptions'&&c.path==='packages/query-core/src/types.ts'));}
  assert.ok(candidate.discovery===null||candidate.discovery.readBytes<=1024*1024);reports.push({task:task.id,query,flagOffMatchesSealedReference:true,reference,candidate});
 }
 await rm(root,{recursive:true,force:true});
}}finally{if(previous===undefined)delete process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER;else process.env.BLAME_AGENT_DECLARATION_SOURCE_ORDER=previous;}
await atomicJson(join(work,'local-replays.json'),{externalModelRequests:0,reports,boundary:'Same original source and query; only bounded declaration-visit ordering changes. Aliases/source-revision identifiers are excluded from structural comparison. Lexical result ranks, parser limits and navigation-only status are preserved.'});console.log('Replayed four real queries against sealed F69 and new runtime.');
