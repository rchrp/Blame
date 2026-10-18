// Known-project local control only; no model or task completion claim.
import assert from 'node:assert/strict';
import {mkdir,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {prepare} from '../navigation-large-model-study/setup.mjs';
import {atomicJson} from '../durable-campaign.mjs';
const repo=resolve(import.meta.dirname,'../../..'),work='/workspace/blame-study-runs/harness-feedback-f57',root=join(work,'real-navigation');
await mkdir(root,{recursive:true});await prepare(root,'suffix-counts');
const rows=[];
try{
  for(const stage of ['baseline','navigation','current']){
    const path=stage==='current'?join(repo,'packages/agent-runtime/dist/harness'):join(work,stage,'dist/harness');
    const {LightWorkspace}=await import(pathToFileURL(join(path,'light-workspace.js')));
    const workspace=new LightWorkspace(root,{sessionId:'real-navigation-'+stage});
    for(const query of ['takeLast','dropLast','clamp','splitAt']){
      const result=await workspace.searchCode({query,mode:'text',scope:'packages/remeda/src'});assert.equal(result.status,'ok');
      const candidates=result.data.declarationCandidates??[];
      rows.push({stage,query,result,exactRoute:candidates.some(c=>c.target===`packages/remeda/src/${query}.ts#${query}`)});
    }
  }
}finally{await rm(root,{recursive:true});}
const counts=['baseline','navigation','current'].map(stage=>rows.filter(row=>row.stage===stage&&row.exactRoute).length);
assert.equal(counts[0],0);assert.equal(counts[2],4);
const moduleHashes={};for(const stage of ['baseline','navigation','current']){
  const root=stage==='current'?join(repo,'packages/agent-runtime/dist/harness'):join(work,stage,'dist/harness');
  for(const name of ['light-workspace','light-reference-candidates','light-reference-search'])moduleHashes[stage+'/'+name]=createHash('sha256').update(await readFile(join(root,name+'.js'))).digest('hex');
}
await atomicJson(join(repo,'docs/experiments/light-harness-feedback-f57-2026-10-18/real-navigation.json'),{phase:'F57',modelRequests:0,
  note:'Four preselected API names on the pinned known Remeda archive. Filename-first ordering finds all four while retaining incomplete-scan labels; unprioritized bounded scans may miss later declarations. This is local navigation capability, not agent adoption or task success.',counts,moduleHashes,rows});
console.log('Known Remeda local text routes (baseline, unprioritized, filename-prioritized):',counts);
