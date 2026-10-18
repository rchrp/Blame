// Apply each original patch to pristine input, never repair source or call a model.
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {readFile,writeFile,mkdir,rm,access,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {work,study,json,sha,prepare} from './setup.mjs';
import {check,checkNames} from './checks.mjs';
const output=process.argv.find(x=>x.startsWith('--output='))?.slice(9);assert.ok(output,'Explicit --output required');
await access(resolve(output)).then(()=>{throw Error('Refusing to overwrite replay');},error=>{if(error.code!=='ENOENT')throw error;});
const protocol=await json(join(study,'protocol.json')),results=await json(join(study,'results.json'));
for(const [name,hash]of Object.entries((await json(join(study,'input-archives.json'))).artifacts))assert.equal(sha(await readFile(join(study,'inputs',name))),hash);
await mkdir(work,{recursive:true});const root=await mkdtemp(join(work,'endpoint-replay-')),rows=[];
for(const row of results.rows){
 const archive=await readFile(join(study,'traces',row.name+'.json.gz'));assert.equal(sha(archive),row.traceSha256);const files=JSON.parse(gunzipSync(archive)).files;
 const bytes=name=>{const b=Buffer.from(files[name].base64,'base64');assert.equal(sha(b),files[name].sha256);return b;};
 const grade=JSON.parse(bytes('score.json')),folder=join(root,row.name);await prepare(folder,row.task);
 const patch=join(root,row.name+'.patch');await writeFile(patch,bytes('workspace.diff'));
 if(bytes('workspace.diff').length)execFileSync('git',['apply','--binary',patch],{cwd:folder});
 for(const path of grade.protectedPaths){const tracked=spawnSync('git',['ls-files','--error-unmatch','--',path],{cwd:folder,stdio:'ignore'}).status===0;if(tracked)execFileSync('git',['restore','--source=HEAD','--',path],{cwd:folder});else await rm(join(folder,path),{recursive:true,force:true});}
 const checks=checkNames.map(name=>check(folder,name,row.task)),original=[...grade.checks,...grade.deliveredChecks];
 const matches=checks.every((c,i)=>c.exitCode===original[i].exitCode&&c.signal===original[i].signal);
 rows.push({name:row.name,matches,original:original.map(c=>({exitCode:c.exitCode,signal:c.signal})),checks});
 await rm(folder,{recursive:true});await rm(patch);console.log(row.name,matches?'MATCH':'MISMATCH');
}
await writeFile(resolve(output),JSON.stringify({phase:'F52',modelRequests:0,method:'Original unchanged patch on pristine constructed input, protected checks restored as in the original grader. Identical endpoint outcomes establish reproducibility, not new agent successes.',rows},null,2)+'\n',{flag:'wx'});if(rows.some(r=>!r.matches))process.exitCode=1;
