// Offline sensitivity analysis of unchanged archived authored tests. Not rescoring.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {repo,work,study,prepare,save,sha} from './setup.mjs';
import * as confirmation from './ts-pattern.mjs';
const rows=[];
const split=patch=>patch.split(/(?=^diff --git )/m).filter(Boolean).map(text=>({text,path:text.split('\n')[0].split(' b/')[1]}));
const isTest=p=>/\.(?:test|spec)(?:-d)?\.ts$/.test(p);
async function archived(panel,name){
  const root=join(repo,'docs/experiments/light-harness-feedback-'+panel+'-2026-10-18');
  const results=JSON.parse(await readFile(join(root,'results.json'),'utf8'));
  const raw=await readFile(join(root,'traces',name+'.json.gz'));assert.equal(sha(raw),results.rows.find(r=>r.name===name).traceSha256);
  const file=JSON.parse(gunzipSync(raw)).files['workspace.diff'],bytes=Buffer.from(file.base64,'base64');assert.equal(sha(bytes),file.sha256);
  return {name,panel,patchSha256:sha(bytes),blocks:split(bytes.toString())};
}
async function runTestSet(author,production,label){
  const root=join(work,'contract-controls',label);await rm(root,{recursive:true,force:true});
  if(author.panel==='f61')await confirmation.prepare(root,'alternative-selections');else await prepare(root,'suffix-counts');
  const tests=author.blocks.filter(b=>isTest(b.path)),prod=production?.blocks.filter(b=>b.path.endsWith('.ts')&&!isTest(b.path))??[];
  assert.ok(tests.length);for(const b of [...tests,...prod])assert.ok(b.path&&!b.path.startsWith('/')&&!b.path.split('/').includes('..'));
  execFileSync('git',['apply','--binary','-'],{cwd:root,input:[...prod,...tests].map(b=>b.text).join('')});
  const paths=tests.map(t=>t.path);await writeFile(join(root,'.study/sensitivity.vitest.mjs'),'export default '+JSON.stringify({test:{include:paths.filter(p=>p.endsWith('.test.ts')),maxWorkers:1,fileParallelism:false,cache:false}})+';\n');
  const argv=['node_modules/vitest/vitest.mjs','run','--config','.study/sensitivity.vitest.mjs','--reporter=json','--outputFile=.study/sensitivity.json'];
  const r=spawnSync(process.execPath,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC'}});
  let report;try{report=JSON.parse(await readFile(join(root,'.study/sensitivity.json'),'utf8'));}catch{}
  const cases=(report?.testResults??[]).filter(f=>paths.includes(relative(root,f.name).replaceAll('\\','/'))).flatMap(f=>f.assertionResults??[]);
  const passed=cases.filter(c=>c.status==='passed').length,failed=cases.filter(c=>c.status==='failed').length,other=cases.length-passed-failed;
  const outcome=r.status===0&&cases.length>0&&passed===cases.length?'tests_pass':failed>0?'runtime_case_failure':'setup_or_no_active_cases';
  const item={label,author:{panel:author.panel,name:author.name,patchSha256:author.patchSha256},production:production?{panel:production.panel,name:production.name,patchSha256:production.patchSha256}:'pristine frozen production',
    command:process.execPath,argv,exitCode:r.status,signal:r.signal,error:r.error?.code??null,authoredFiles:paths,counts:{passed,failed,other},outcome,report:report??null,stdout:r.stdout,stderr:r.stderr};
  rows.push(item);await save(join(study,'contract-test-sensitivity.json'),{complete:false,modelRequests:0,rows});
  console.log(label,outcome,JSON.stringify(item.counts));await rm(root,{recursive:true});return item;
}
const names=['1-suffix-counts-reference','1-suffix-counts-candidate','1-suffix-counts-cline','2-suffix-counts-reference','2-suffix-counts-candidate','2-suffix-counts-cline'];
const authors=await Promise.all(names.map(n=>archived('f60',n))),defects=authors.filter(a=>a.name.endsWith('-candidate'));
for(const author of authors){const control=await runTestSet(author,author,'self-'+author.name);assert.equal(control.outcome,'tests_pass','Unchanged original tests must reproduce their own recorded runtime pass');}
for(const defect of defects)for(const author of authors)await runTestSet(author,defect,defect.name+'--'+author.name);
for(const repeat of [1,2])for(const arm of ['reference','candidate','cline']){const author=await archived('f61',repeat+'-alternative-selections-'+arm);await runTestSet(author,null,'pristine--'+author.name);}
await save(join(study,'contract-test-sensitivity.json'),{complete:true,modelRequests:0,
  method:'New authored test files are copied unchanged into clean pinned inputs. F60 self controls reproduce their own runtime results; then each authored test set is run against both archived faulty suffix implementations. F61 alternative tests run against pristine production known to violate the requested partial-selection contract. Only these authored files execute, with the pinned Vitest adapter and JSON case evidence. A runtime case failure differs from setup/import failure or no active cases. No historical score changes, patch repairs, retrieved solutions or new model calls.',
  knownDefectBoundary:{length:2,count:3,note:'The original F60 oracle already detected these defects. New relative-boundary probes strengthen local diagnostic breadth, not repair a historically missed official failure.'},rows});
