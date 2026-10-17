// Post-hoc endpoint interpretation only. No model, repair, direct tierCost check or new success.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {access,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=path=>readFile(path,'utf8').then(JSON.parse);

async function child(root){
 const {lowerTierUnits,upperTierUnits}=await import(pathToFileURL(join(root,'packages/tiers/src/index.ts')));
 const {quoteTierUsage}=await import(pathToFileURL(join(root,'apps/policy/src/tiers.ts')));
 const counts={},failures={},grid=[-3,-2,-1,0,1,2,3];
 const call=(fn,args)=>{try{return fn(...args);}catch(error){return{thrown:String(error?.message??error).slice(0,200)};}};
 const check=(kind,actual,expected,input)=>{const row=counts[kind]??={total:0,failed:0};row.total++;
  if(!isDeepStrictEqual(actual,expected)){row.failed++;const examples=failures[kind]??=[];if(examples.length<2)examples.push({input,actual,expected});}};
 for(const first of grid)for(const last of grid)for(const boundary of grid){
  const input={first,last,boundary},units=[];for(let unit=first;unit<=last;unit++)units.push(unit);
  const lower=call(lowerTierUnits,[first,last,boundary]),upper=call(upperTierUnits,[first,last,boundary]);
  check('lower',lower,units.filter(unit=>unit<=boundary).length,input);
  check('upper',upper,units.filter(unit=>unit>boundary).length,input);
  check('conservation',typeof lower==='number'&&typeof upper==='number'?lower+upper:null,units.length,input);
  check('nonnegativeIntegers',[lower,upper].every(value=>Number.isInteger(value)&&value>=0),true,input);
  for(const lowerRate of grid)for(const upperRate of grid){
   const expected={lower:units.filter(unit=>unit<=boundary).length,upper:units.filter(unit=>unit>boundary).length,
    totalCost:units.reduce((total,unit)=>total+Math.max(unit<=boundary?lowerRate:upperRate,0),0)};
   check('quote',call(quoteTierUsage,[first,last,boundary,lowerRate,upperRate]),expected,{...input,lowerRate,upperRate});
  }
 }
 const failed=Object.values(counts).reduce((sum,row)=>sum+row.failed,0);
 console.log(JSON.stringify({status:failed?'failed':'passed',counts,failures,directTierCostCalled:false}));
 process.exitCode=failed?1:0;
}

async function main(){
 const repo=resolve(import.meta.dirname,'../../..'),study=join(repo,'docs/experiments/light-harness-symbolic-model-f50-2026-10-18');
 const campaign='/tmp/blame-symbolic-model-f50/campaign',output=process.argv.find(value=>value.startsWith('--output='))?.slice(9);
 assert.ok(output,'Explicit --output=<new-file> required');
 await access(resolve(output)).then(()=>{throw Error('Refusing to overwrite diagnostic');},error=>{if(error.code!=='ENOENT')throw error;});
 const protocolPath=join(study,'interpretation-replay-protocol.json'),registration=await json(protocolPath);
 assert.equal(registration.modelRequests,0);assert.equal(registration.primaryResultsChanged,false);
 assert.equal(sha(await readFile(import.meta.filename)),registration.scriptSha256,'Post-hoc diagnostic changed since registration');
 assert.equal(sha(await readFile(join(study,'protocol.json'))),registration.campaignProtocolSha256);
 const campaignProtocol=await json(join(study,'protocol.json'));
 const publicResults=await json(join(study,'results.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const done=await json(join(publicResults?study:campaign,'driver-exit.json'));
 assert.equal(done.complete,true,'Run only after all model workers finish');assert.equal(done.completed,18);
 const ledger=publicResults??await json(join(campaign,'analysis.json'));
 const selected=ledger.rows.filter(row=>row.task==='inclusive-tier-allocation');
 assert.equal(selected.length,6);assert.deepEqual(selected.map(row=>row.name),registration.endpoints);
 const artifacts=await json(join(study,'input-archives.json')),input=join(study,'inputs/integer-policy-kit.tar.gz');
 assert.equal(sha(await readFile(input)),artifacts.artifacts['integer-policy-kit.tar.gz']);
 const dependencies=join(repo,'.blame/research/validation-scope-f44/dependencies');
 assert.equal(sha(await readFile(join(dependencies,'package-lock.json'))),campaignProtocol.execution.dependencyLockSha256);
 const sourceHashes=async root=>{const files=(await readdir(root,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile())
   .map(entry=>join(entry.parentPath,entry.name)).filter(path=>/^(?:packages|apps)\/.+\.ts$/u.test(relative(root,path))).sort();
  return Object.fromEntries(await Promise.all(files.map(async path=>[relative(root,path),sha(await readFile(path))])));};
 const work=await mkdtemp('/tmp/blame-f50-interpretation-'),rows=[];
 try{
  for(const row of selected){
   let patch,grade,scoreBytes,origin;
   if(publicResults){const archive=await readFile(join(study,'traces',row.name+'.json.gz'));assert.equal(sha(archive),row.traceSha256);
    const files=JSON.parse(gunzipSync(archive)).files;
    const bytes=name=>{const value=Buffer.from(files[name].base64,'base64');assert.equal(sha(value),files[name].sha256);return value;};
    patch=bytes('workspace.diff');scoreBytes=bytes('score.json');grade=JSON.parse(scoreBytes);origin={publicTraceSha256:row.traceSha256};
   }else{const directory=join(campaign,row.name),sealed=await json(join(directory,'workspace-archive.json'));
    assert.equal(sha(await readFile(join(directory,'workspace.tar.gz'))),sealed.sha256);
    patch=await readFile(join(directory,'workspace.diff'));scoreBytes=await readFile(join(directory,'score.json'));grade=JSON.parse(scoreBytes);origin={privateWorkspaceArchiveSha256:sealed.sha256};}
   assert.equal(sha(patch),row.hashes['workspace.diff']);
   assert.equal(sha(scoreBytes),row.hashes['score.json']);
   const root=join(work,row.name);await mkdir(root);execFileSync('tar',['-xzf',input,'-C',root]);
   await symlink(join(dependencies,'node_modules'),join(root,'node_modules'));
   const patchPath=join(work,row.name+'.patch');await writeFile(patchPath,patch);
   if(patch.length)execFileSync('git',['apply','--binary',patchPath],{cwd:root});
   for(const[path,hash]of Object.entries(grade.sourceHashes)){const current=await readFile(join(root,path)).then(sha,error=>{if(error.code==='ENOENT')return null;throw error;});assert.equal(current,hash,'Original endpoint mismatch: '+path);}
   const before=await sourceHashes(root),started=performance.now();
   const result=spawnSync(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),import.meta.filename,'--child',root],{
    cwd:root,encoding:'utf8',timeout:30000,maxBuffer:65536,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',NODE_PATH:'',TZ:'UTC',CI:'true',NO_COLOR:'1'}});
   const after=await sourceHashes(root),unchanged=isDeepStrictEqual(before,after);let observation;
   try{observation=JSON.parse(result.stdout);}catch{observation={status:'unknown',reason:'missing_or_malformed_child_output'};}
   if(observation.status==='passed'&&result.status!==0||observation.status==='failed'&&result.status!==1)
    observation={...observation,status:'unknown',reason:'inconsistent_child_exit'};
   if(result.error||result.signal||!unchanged)observation={...observation,status:'unknown',reason:!unchanged?'source_changed':result.error?.code??result.signal};
   rows.push({name:row.name,...origin,patchSha256:sha(patch),gradeSha256:row.hashes['score.json'],protectedPaths:grade.protectedPaths,
    sourceHashesBefore:before,sourceHashesAfter:after,unchanged,durationMs:performance.now()-started,
    exitCode:result.status,signal:result.signal,error:result.error?.code??null,stdoutSha256:sha(result.stdout??''),stderrSha256:sha(result.stderr??''),stderr:(result.stderr??'').slice(0,1000),observation});
   await rm(root,{recursive:true,force:true});
  }
  await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(resolve(output),JSON.stringify({modelRequests:0,primaryResultsChanged:false,protocolSha256:sha(await readFile(protocolPath)),method:registration.interpretation,rows},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output:resolve(output),endpoints:rows.length,unchanged:rows.filter(row=>row.unchanged).length,observations:rows.map(row=>({name:row.name,status:row.observation.status}))}));
 }finally{await rm(work,{recursive:true,force:true});}
}
if(process.argv[2]==='--child')await child(resolve(process.argv[3]));else await main();
