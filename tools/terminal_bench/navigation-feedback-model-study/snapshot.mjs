import assert from 'node:assert/strict';
import {access, cp, mkdir, readdir, symlink, readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {repo,work,study,save,sha} from '../navigation-large-model-study/setup.mjs';
const frozen=join(work,'frozen'),stages='/workspace/blame-study-runs/harness-feedback-f57';
await access(frozen).then(()=>{throw Error('Refuse replacing snapshot');},error=>{if(error.code!=='ENOENT')throw error;});
for(const arm of ['reference','current'])for(const name of ['agent-runtime','benchmark-runner']){
  const target=join(frozen,arm,name),source=join(repo,'packages',name);await mkdir(target,{recursive:true});
  await cp(name==='agent-runtime'?join(stages,'baseline/dist'):join(source,'dist'),join(target,'dist'),{recursive:true});
  await cp(join(source,'package.json'),join(target,'package.json'));
  if(name==='agent-runtime')await symlink(join(source,'node_modules'),join(target,'node_modules'));
  else{await mkdir(join(target,'node_modules/@blame'),{recursive:true});await symlink(join(frozen,arm,'agent-runtime'),join(target,'node_modules/@blame/agent-runtime'));}
}
for(const name of ['light-reference-candidates','light-reference-search','light-workspace'])await cp(join(stages,'navigation/dist/harness',name+'.js'),join(frozen,'current/agent-runtime/dist/harness',name+'.js'));
const files={};for(const entry of await readdir(frozen,{recursive:true,withFileTypes:true}))if(entry.isFile()){const path=join(entry.parentPath,entry.name);files[relative(frozen,path)]=sha(await readFile(path));}
const differences=Object.keys(files).filter(path=>path.startsWith('current/')&&files['reference/'+path.slice(8)]!==files[path]).map(path=>path.slice(8)).sort();
assert.deepEqual(differences,['light-reference-candidates','light-reference-search','light-workspace'].map(name=>'agent-runtime/dist/harness/'+name+'.js').sort());
const resolved={};for(const arm of ['current','reference']){resolved[arm]=createRequire(join(frozen,arm,'benchmark-runner/dist/cli.js')).resolve('@blame/agent-runtime');assert.equal(resolved[arm],join(frozen,arm,'agent-runtime/dist/index.js'));}
await save(join(study,'snapshot.json'),{sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),createdUTC:new Date().toISOString(),files,differences,resolved,
  mechanism:'Baseline b70c21fa executable bytes plus only ordinary-search declaration routes from 53e75b43. Both exclude later body-header and failed-check scheduling changes. Nonexecuted declaration/maps stay common.'});
console.log(JSON.stringify({differences,resolved}));
