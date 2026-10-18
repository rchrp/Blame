// Root runs this only after the selected shared runtime/runner build is verified.
import assert from 'node:assert/strict';
import {access,mkdir,cp,symlink,readFile,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {repo,work,study,sha,save} from './setup.mjs';
const destination=join(work,'frozen/current');
await access(destination).then(()=>{throw Error('Refusing to overwrite selected runtime');},e=>{if(e.code!=='ENOENT')throw e;});
for(const name of ['agent-runtime','benchmark-runner']){
 const source=join(repo,'packages',name),target=join(destination,name);await mkdir(target,{recursive:true});
 await cp(join(source,'dist'),join(target,'dist'),{recursive:true});await cp(join(source,'package.json'),join(target,'package.json'));
 if(name==='agent-runtime')await symlink(join(source,'node_modules'),join(target,'node_modules'),'dir');
 else{await mkdir(join(target,'node_modules/@blame'),{recursive:true});await symlink(join(destination,'agent-runtime'),join(target,'node_modules/@blame/agent-runtime'),'dir');}
}
const sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),files={};
for(const entry of await readdir(destination,{recursive:true,withFileTypes:true}))if(entry.isFile()){const path=join(entry.parentPath,entry.name);files[relative(destination,path)]=sha(await readFile(path));}
assert.ok(files['agent-runtime/dist/harness/symbolic-analysis.js']);
const runnerRequire=createRequire(join(destination,'benchmark-runner/dist/cli.js'));const resolvedRuntime=runnerRequire.resolve('@blame/agent-runtime');assert.equal(resolvedRuntime,join(destination,'agent-runtime/dist/index.js'),'Frozen runner must resolve frozen runtime');
await save(join(study,'snapshot.json'),{sourceHead,resolvedRuntime,createdUTC:new Date().toISOString(),runtimeSha256:sha(JSON.stringify(files)),files,treatment:'One identical executable snapshot for reference, candidate and integrated Cline. Both Light arms expose the same analysis schema; only BLAME_AGENT_SYMBOLIC_HINTS false/true differs. Solver executable and availability are the same in all arms. Additional body-read hint output and consequent requests/cache effects are the treatment.'});
console.log(JSON.stringify({destination,sourceHead,files:Object.keys(files).length}));
