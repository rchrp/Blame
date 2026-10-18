import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
export function check(root,name,task){
 const external=name==='feature';const command=external?process.execPath:'npm';
 const argv=external?['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(import.meta.dirname,'oracle.mjs'),root,task]:['run',name==='delivered-types'?'typecheck:delivered':'test:study:'+name];
 const started=performance.now();const r=spawnSync(command,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',PATH:join(root,'node_modules/.bin')+':'+process.env.PATH,npm_config_offline:'true',npm_config_update_notifier:'false'}});
 return {name,command,argv,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-started,stdout:r.stdout,stderr:r.stderr};
}
export const checkNames=['regression','feature','types','delivered','delivered-types'];
