import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareIsolatedNodeEnvironment} from '../isolated-node-environment.mjs';
import {fixture} from './fixture.mjs';
import {tasks} from './tasks.mjs';
export const repo=resolve(import.meta.dirname,'../../..');
export const work='/tmp/blame-symbolic-discovery-f52';
export const study=join(repo,'docs/experiments/light-harness-symbolic-discovery-f52-2026-10-18');
export const dependencyRoot=join(repo,'.blame/research/validation-scope-f44/dependencies');
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const json=p=>readFile(p,'utf8').then(JSON.parse);
export const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
export const sourceRoot=()=>'';
export async function prepare(root,id,isolated=false){
 if(!tasks.some(t=>t.id===id))throw Error('Unknown task '+id);
 await mkdir(root,{recursive:true});
 for(const [path,contents]of Object.entries(fixture())){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),contents);}
 await mkdir(join(root,'scripts'));await cp(join(import.meta.dirname,'delivered.mjs'),join(root,'scripts/delivered.mjs'));
 if(isolated){
  const environment=await prepareIsolatedNodeEnvironment({baselineModules:join(dependencyRoot,'node_modules'),workspace:root,cacheRoot:resolve(root,'../npm-cache')});
  environment.env.PATH=join(root,'node_modules/.bin')+':'+process.env.PATH;
  const shellPath=resolve(root,'../shell-environment.sh'),quote=x=>"'"+x.replaceAll("'","'\\''")+"'";
  const shell=Object.entries(environment.env).map(([key,value])=>'export '+key+'='+quote(value)).join('\n')+'\n';
  await writeFile(shellPath,shell);environment.env.BASH_ENV=shellPath;environment.shellEnvironmentSha256=sha(shell);await save(resolve(root,'../environment.json'),environment);
 }else await symlink(join(dependencyRoot,'node_modules'),join(root,'node_modules'));
 execFileSync('git',['init','--quiet'],{cwd:root});await writeFile(join(root,'.git/info/exclude'),'.blame/\nnode_modules/\n');execFileSync('git',['add','.'],{cwd:root});
 execFileSync('git',['-c','user.name=Study','-c','user.email=study@example.invalid','commit','--quiet','-m','Frozen constructed multi-package study input'],{cwd:root,env:{...process.env,GIT_AUTHOR_DATE:'2026-10-18T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-18T00:00:00Z'}});
}
