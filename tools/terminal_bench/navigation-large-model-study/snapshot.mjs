// Freeze the common selected runtime, then ablate only navigation/edit feedback modules.
import assert from 'node:assert/strict';import {access,cp,mkdir,readFile,readdir,rm,symlink} from 'node:fs/promises';import {join,relative} from 'node:path';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
import {repo,work,study,save,sha} from './setup.mjs';
const frozen=join(work,'frozen');await access(frozen).then(()=>{throw Error('Refuse replacing snapshot');},e=>{if(e.code!=='ENOENT')throw e;});
for(const arm of ['current','reference'])for(const name of ['agent-runtime','benchmark-runner']){
 const target=join(frozen,arm,name),source=join(repo,'packages',name);await mkdir(target,{recursive:true});await cp(join(source,'dist'),join(target,'dist'),{recursive:true});await cp(join(source,'package.json'),join(target,'package.json'));
 if(name==='agent-runtime')await symlink(join(source,'node_modules'),join(target,'node_modules'));
 else{await mkdir(join(target,'node_modules/@blame'),{recursive:true});await symlink(join(frozen,arm,'agent-runtime'),join(target,'node_modules/@blame/agent-runtime'));}
}
const old='/workspace/blame-study-runs/f50-restored/current/agent-runtime/dist/harness';
for(const name of ['light-edit','light-reference-search'])for(const suffix of ['.js'])await cp(join(old,name+suffix),join(frozen,'reference/agent-runtime/dist/harness',name+suffix));
const files={};for(const e of await readdir(frozen,{recursive:true,withFileTypes:true}))if(e.isFile()){const p=join(e.parentPath,e.name);files[relative(frozen,p)]=sha(await readFile(p));}
const differences=[];for(const [p,h]of Object.entries(files))if(p.startsWith('current/')&&files['reference/'+p.slice(8)]!==h)differences.push(p.slice(8));
assert.equal(differences.length,2);for(const p of differences)assert.match(p,/^agent-runtime\/dist\/harness\/light-(?:edit|reference-search)\.(?:js(?:\.map)?|d\.ts)$/);
const resolved={};for(const arm of ['current','reference']){resolved[arm]=createRequire(join(frozen,arm,'benchmark-runner/dist/cli.js')).resolve('@blame/agent-runtime');assert.equal(resolved[arm],join(frozen,arm,'agent-runtime/dist/index.js'));}
await save(join(study,'snapshot.json'),{sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),createdUTC:new Date().toISOString(),files,differences,resolved,sourceOfAblatedModules:old,mechanism:'Only two executable JavaScript modules differ; declaration metadata is common. Compact declaration feedback and repeated-noop body guidance differ. Alias safety, compiler identity, validation evidence and all other current modules are common.'});
console.log(JSON.stringify({differences,resolved}));
