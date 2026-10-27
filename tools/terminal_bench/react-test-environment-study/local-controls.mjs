// Local compiler regressions, not model trials or repairs of any archived patch.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {restoreInput} from '../inspection-wait-study/restore-input.mjs';
import {baselineModules,repo} from '../inspection-wait-study/inputs.mjs';
import {atomicJson,digest} from '../durable-campaign.mjs';
const study=join(repo,'docs/experiments/light-harness-react-test-environment-f73-2026-10-27');
const parent=JSON.parse(await readFile(join(repo,'docs/experiments/light-harness-inspection-wait-f72-2026-10-27/model-protocol.json')));
const root=await mkdtemp('/workspace/blame-study-runs/react-test-environment-f73-');
await restoreInput(root,'fetching-filters',parent,{portable:true});await cp(baselineModules(),join(root,'node_modules'),{recursive:true,verbatimSymlinks:true});
const original=await readFile(join(root,'.study/checks.mjs')),corrected=await readFile(join(repo,'tools/terminal_bench/context-economy-study/project-checks.mjs'));
const registration=JSON.parse(await readFile(join(study,'selection-registration.json')));assert.equal(digest(original),registration.oldTemplateSha256);
const setup=join(root,'packages/react-query/test-setup.ts'),setupSha=digest(await readFile(setup)),rows=[];
const react='packages/react-query/src/__tests__/ambient-control.test.tsx',core='packages/query-core/src/__tests__/ambient-control.test.ts';
const cases=[{name:'react-matcher',path:react,text:"import {expect,test} from 'vitest';test('matcher',()=>expect(document.createElement('div')).toBeInTheDocument());\n",expected:[2,0]},
 {name:'react-real-type-error',path:react,text:"import {expect,test} from 'vitest';test('matcher',()=>expect(document.createElement('div')).toBeInTheDocument());const wrong:string=1;void wrong;\n",expected:[2,2]},
 {name:'core-only',path:core,text:"import {expect,test} from 'vitest';test('matcher',()=>expect(document.createElement('div')).toBeInTheDocument());\n",expected:[2,2]},
 {name:'no-new-tests',expected:[1,1]}];
for(const entry of cases){
 for(const path of [react,core])await rm(join(root,path),{force:true});
 if(entry.path)await writeFile(join(root,entry.path),entry.text);
 const runs=[];
 for(const [index,adapter]of [original,corrected].entries()){
  await writeFile(join(root,'.study/checks.mjs'),adapter);
  const r=spawnSync(process.execPath,['.study/checks.mjs','delivered-types'],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  const result={adapter:index?'corrected':'original',exitCode:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr};runs.push(result);
  await atomicJson(join(study,'controls.json'),{complete:false,rows:[...rows,{name:entry.name,runs}]});
  assert.equal(r.status,entry.expected[index],entry.name+' '+result.adapter+'\n'+r.stdout+r.stderr);
  if(entry.name==='react-real-type-error'){assert.match(r.stdout,/error TS2322/u);if(index)assert.doesNotMatch(r.stdout,/error TS2339/u);}
  if(entry.name==='core-only'){assert.match(r.stdout,/error TS2339/u);const config=JSON.parse(await readFile(join(root,'.study/reports/delivered-tsconfig.json')));assert.ok(!config.files.some(p=>p.endsWith('/test-setup.ts')));}
  if(entry.name==='no-new-tests')assert.match(r.stderr,/No new test\/type regression/u);
 }
 rows.push({name:entry.name,runs});console.log('CONTROL',entry.name,'passed');
}
assert.equal(digest(await readFile(setup)),setupSha);
await atomicJson(join(study,'controls.json'),{complete:true,externalModelRequests:0,node:process.version,originalAdapterSha256:digest(original),correctedAdapterSha256:digest(corrected),unchangedUpstreamSetupSha256:setupSha,rows,boundary:'Only synthetic compiler fixtures and grader adapter differ. Eight actual compiler/selection runs preserve real type errors, core-only environment and missing-test refusal. No model patch, frozen task input, historical result or required execution evidence changes. Future campaigns require a new input/adaptor version.'});
await rm(root,{recursive:true,force:true});
