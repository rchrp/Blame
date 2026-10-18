import assert from 'node:assert/strict';
import {access,cp,mkdir,readdir,symlink,readFile,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {repo,work,study,save,sha} from './setup.mjs';
import {panel} from './panels.mjs';
const frozen=join(work,'frozen'),stages='/workspace/blame-study-runs/harness-feedback-f57';
await access(frozen).then(()=>{throw Error('Refuse replacing snapshot');},e=>{if(e.code!=='ENOENT')throw e;});
for(const arm of ['reference','current'])for(const name of ['agent-runtime','benchmark-runner']){
 const target=join(frozen,arm,name),source=join(repo,'packages',name);await mkdir(target,{recursive:true});
 await cp(join(source,'dist'),join(target,'dist'),{recursive:true});await cp(join(source,'package.json'),join(target,'package.json'));
 if(name==='agent-runtime')await symlink(join(source,'node_modules'),join(target,'node_modules'));
 else {await mkdir(join(target,'node_modules/@blame'),{recursive:true});await symlink(join(frozen,arm,'agent-runtime'),join(target,'node_modules/@blame/agent-runtime'));}
}
const before=join(frozen,'reference/agent-runtime/dist');
if(panel.kind==='repair')for(const name of ['light-workspace','light-finish-service'])await cp(join(stages,'body/dist/harness',name+'.js'),join(before,'harness',name+'.js'));
else if(panel.kind==='body')await cp(join(stages,'navigation/dist/harness/light-edit.js'),join(before,'harness/light-edit.js'));
else if(panel.kind==='provenance') {
 const previous=await readFile(join(repo,'docs/experiments/light-harness-feedback-f61-2026-10-18/snapshot.json'),'utf8').then(JSON.parse);
 const archive=join(repo,'docs/experiments/light-harness-feedback-f61-2026-10-18/inputs/frozen-runtimes.tar.gz');
 const hashes=await readFile(join(repo,'docs/experiments/light-harness-feedback-f61-2026-10-18/input-archives.json'),'utf8').then(JSON.parse);
 assert.equal(sha(await readFile(archive)),hashes.artifacts['frozen-runtimes.tar.gz']);
 for(const name of ['light-workspace','light-finish-service','light-validation-report']) {
  const path='agent-runtime/dist/harness/'+name+'.js',bytes=execFileSync('tar',['-xOf',archive,'./current/'+path]);
  assert.equal(sha(bytes),previous.files['current/'+path],'Baseline must be exact F61 current executable');
  await writeFile(join(before,'harness',name+'.js'),bytes);
 }
}
else {
 // Preserve common declarations/maps; compare only executable JS treatment.
 for(const entry of await readdir(join(stages,'baseline/dist'),{recursive:true,withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.js')){
 const src=join(entry.parentPath,entry.name),dst=join(before,relative(join(stages,'baseline/dist'),src));await mkdir(join(dst,'..'),{recursive:true});await cp(src,dst);
 }
}
const files={};for(const entry of await readdir(frozen,{recursive:true,withFileTypes:true}))if(entry.isFile()){const p=join(entry.parentPath,entry.name);files[relative(frozen,p)]=sha(await readFile(p));}
const differences=Object.keys(files).filter(p=>p.startsWith('current/')&&files['reference/'+p.slice(8)]!==files[p]).map(p=>p.slice(8)).sort();
if(panel.kind!=='confirmation')assert.deepEqual(differences,(panel.kind==='repair'?['light-finish-service','light-workspace']:panel.kind==='provenance'?['light-finish-service','light-validation-report','light-workspace']:['light-edit']).map(n=>'agent-runtime/dist/harness/'+n+'.js').sort());
assert.ok(differences.length);
const resolved={};for(const arm of ['reference','current']){resolved[arm]=createRequire(join(frozen,arm,'benchmark-runner/dist/cli.js')).resolve('@blame/agent-runtime');assert.equal(resolved[arm],join(frozen,arm,'agent-runtime/dist/index.js'));}
await save(join(study,'snapshot.json'),{sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),createdUTC:new Date().toISOString(),files,differences,resolved,mechanism:panel.description});
console.log(JSON.stringify({panel:panel.id,differences}));
