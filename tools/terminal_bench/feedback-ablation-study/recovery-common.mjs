import {mkdir,writeFile,symlink,readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {prepareIsolatedNodeEnvironment} from '../isolated-node-environment.mjs';
export const repo=resolve(import.meta.dirname,'../../..');
export const deps=join(repo,'.blame/research/validation-recovery-f63/dependencies');
export const registration=JSON.parse(await readFile(join(repo,'docs/experiments/light-harness-validation-recovery-f63-2026-10-19/selection-registration.json'),'utf8'));
export const compilerOptions={strict:true,noEmit:true,target:'ES2022',lib:['ESNext','DOM'],module:'ESNext',moduleResolution:'Bundler',allowImportingTsExtensions:true,skipLibCheck:true,types:['node']};
export async function dependencies(root,isolated){
 if(!isolated){await symlink(join(deps,'node_modules'),join(root,'node_modules'));return;}
 const environment=await prepareIsolatedNodeEnvironment({baselineModules:join(deps,'node_modules'),workspace:root,cacheRoot:resolve(root,'../npm-cache')});
 environment.env.PATH=join(root,'node_modules/.bin')+':'+process.env.PATH;
 const quote=x=>"'"+x.replaceAll("'","'\\''")+"'",shell=Object.entries(environment.env).map(([k,v])=>'export '+k+'='+quote(v)).join('\n')+'\n';
 const shellPath=resolve(root,'../shell-environment.sh');await writeFile(shellPath,shell);environment.env.BASH_ENV=shellPath;
 const {createHash}=await import('node:crypto');environment.shellEnvironmentSha256=createHash('sha256').update(shell).digest('hex');
 await writeFile(resolve(root,'../environment.json'),JSON.stringify(environment,null,2)+'\n');
}
export async function initialize(root){
 execFileSync('git',['init','--quiet'],{cwd:root});await writeFile(join(root,'.git/info/exclude'),'.blame/\nnode_modules/\n');
 execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['add','-f','.study'],{cwd:root});
 execFileSync('git',['-c','user.name=Study','-c','user.email=study@example.invalid','commit','--quiet','-m','Frozen registered input'],{cwd:root,env:{...process.env,GIT_AUTHOR_DATE:'2026-10-19T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-19T00:00:00Z'}});
}
export async function files(root){return (await readdir(root,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(root.length+1).replaceAll('\\','/'));}
export function executeCheck(root,name,id,feature,commands={}){
 const external=name==='feature',command=external?process.execPath:'npm',argv=external?['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(import.meta.dirname,feature),root,id]:['run',commands[name]??(name==='delivered-types'?'typecheck:delivered':'test:study:'+name)];
 const start=performance.now(),r=spawnSync(command,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',PATH:join(root,'node_modules/.bin')+':'+process.env.PATH,npm_config_offline:'true',npm_config_update_notifier:'false'}});
 return {name,command,argv,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr};
}
