// Post-hoc diagnostic; never edit or rescore a model endpoint.
// Run from the repository: BLAME_FEEDBACK_PANEL=F62 node <this file>.
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {prepare,study,work,json,sha,save} from '../../../../tools/terminal_bench/feedback-ablation-study/setup.mjs';

const name='2-slice-index-candidate';
const results=await json(join(study,'results.json'));
const archived=await readFile(join(study,'traces',name+'.json.gz'));
assert.equal(sha(archived),results.rows.find(r=>r.name===name).traceSha256);
const entry=JSON.parse(gunzipSync(archived)).files['workspace.diff'];
const patch=Buffer.from(entry.base64,'base64');assert.equal(sha(patch),entry.sha256);
const blocks=patch.toString().split(/(?=^diff --git )/m).filter(Boolean);
const tests=blocks.filter(b=>b.split('\n')[0].endsWith('.test.ts'));
assert.equal(tests.length,1);
const rows=[];
for(const mode of ['pristine_production_authored_test','unchanged_endpoint_patch']){
  const root=join(work,'delivered-types-diagnostic',mode);
  await rm(root,{recursive:true,force:true});await prepare(root,'slice-index');
  execFileSync('git',['apply','--binary','-'],{cwd:root,input:mode==='unchanged_endpoint_patch'?patch:tests.join('')});
  const argv=['.study/delivered.mjs','types'];
  const r=spawnSync(process.execPath,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  const diagnostics=(r.stdout+r.stderr).split('\n').filter(l=>/error TS\d+:/.test(l));
  assert.equal(r.status,2);assert.equal(diagnostics.length,1);
  assert.match(diagnostics[0],/splitAt.slice-index.test.ts\(40,11\): error TS2322/);
  rows.push({mode,command:process.execPath,argv,exitCode:r.status,diagnostics,stdout:r.stdout,stderr:r.stderr,
    productionSha256:sha(await readFile(join(root,'packages/remeda/src/splitAt.ts'))),
    authoredTestSha256:sha(await readFile(join(root,'packages/remeda/src/splitAt.slice-index.test.ts')))});
  await rm(root,{recursive:true});
}
assert.equal(rows[0].authoredTestSha256,rows[1].authoredTestSha256);
assert.notEqual(rows[0].productionSha256,rows[1].productionSha256);
await save(join(study,'delivered-types-diagnostic.json'),{postHoc:true,modelRequests:0,name,traceSha256:sha(archived),patchSha256:sha(patch),
  scriptSha256:sha(await readFile(new URL(import.meta.url))),
  meaning:'The identical unchanged authored test fails with the same TS2322 on pristine and endpoint production. The test assumes contextual generic inference that the unchanged public curried overload does not provide. This is a delivered-test defect against the preserved API, not a new production-body type regression. Both cases use the pinned compiler and unmodified delivered-test wrapper. No endpoint repair, score change or solution recovery.',rows});
console.log(JSON.stringify(rows.map(({mode,exitCode,diagnostics})=>({mode,exitCode,diagnostics}))));
