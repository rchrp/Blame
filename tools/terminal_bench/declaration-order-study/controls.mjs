import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,mkdtemp,cp,rm} from 'node:fs/promises';import {join} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {endpoint as priorEndpoint,positive as priorPositive} from '../context-economy-study/controls.mjs';import {tasks,work,baselineModules,checksFor} from './inputs.mjs';import {atomicJson,digest} from '../durable-campaign.mjs';
export async function attachDependencies(root,task){await cp(baselineModules(task),join(root,'node_modules'),{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});}
export async function applyOfficial(root,task){execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'.patch'))});}
export async function endpoint(root,name,task){
 if(name!=='compatibility')return priorEndpoint(root,name,task);
 const source=`import {QueryClient,type QueryFilters} from '../../packages/query-core/src';
const q=new QueryClient();
type Compatible=Omit<QueryFilters,'fetchStatus'>;
const explicit:number=q.isFetching<Compatible>({queryKey:['records'],exact:true,predicate:query=>{const key:readonly unknown[]=query.queryKey;return key.length>0;}});
const predicate:NonNullable<Compatible['predicate']>=query=>query.queryKey.length>0;
const inferred:number=q.isFetching({queryKey:['records'],predicate});
q.getQueryCache().findAll({fetchStatus:'idle'});void explicit;void inferred;
`;
 await mkdir(join(root,'.study/reports'),{recursive:true});await writeFile(join(root,'.study/reports/compatibility-probe.ts'),source);
 const base=JSON.parse(await readFile(join(root,'.study/source-tsconfig.json')));delete base.include;delete base.exclude;base.files=['./compatibility-probe.ts'];base.compilerOptions.paths=Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([k,v])=>[k,v.map(p=>'../'+p)]));await writeFile(join(root,'.study/reports/compatibility-tsconfig.json'),JSON.stringify(base));
 const start=performance.now(),r=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','.study/reports/compatibility-tsconfig.json'],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});return {name,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr};
}
export async function positive(root,task){
 await priorPositive(root,task);
 if(task.id==='fetching-filters'){
  const path=join(root,'packages/query-core/src/queryClient.ts'),text=await readFile(path,'utf8'),old="isFetching(filters?: Omit<QueryFilters, 'fetchStatus'>): number {";
  assert.ok(text.includes(old));await writeFile(path,text.replace(old,"isFetching<TQueryFilters extends QueryFilters<any> = QueryFilters>(\n    filters?: TQueryFilters & { fetchStatus?: never },\n  ): number {"));
 }
}
if(process.argv[1]===import.meta.filename){
 await mkdir(join(work,'controls'),{recursive:true});const rows=[];
 for(const task of tasks){
  const root=await mkdtemp(join(work,'controls',task.id+'-'));execFileSync('tar',['-xzf',join(work,'inputs',task.id+'.tar.gz'),'-C',root]);await attachDependencies(root,task);
  const compatibilityBaseline=task.id==='fetching-filters'?await endpoint(root,'compatibility',task):null;if(compatibilityBaseline)assert.equal(compatibilityBaseline.exitCode,0,compatibilityBaseline.stdout);
  await applyOfficial(root,task);const before=await endpoint(root,'official',task),negativeProbe=await endpoint(root,'probe',task);assert.notEqual(before.exitCode,0);assert.notEqual(negativeProbe.exitCode,0);
  await rm(join(root,'packages/query-core/src/__tests__',task.id==='mutation-callbacks'?'study-hidden-error.test.ts':'study-hidden-filter.test-d.ts'));execFileSync('git',['apply','--reverse','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'.patch'))});
  let upstreamCompatibility;
  if(task.id==='fetching-filters'){
   execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'-positive.patch'))});upstreamCompatibility=await endpoint(root,'compatibility',task);assert.notEqual(upstreamCompatibility.exitCode,0,'Upstream nongeneric signature is not a full public-generic compatibility control');execFileSync('git',['apply','--reverse','--whitespace=nowarn','-'],{cwd:root,input:await readFile(join(work,'official',task.id+'-positive.patch'))});
  }
  await positive(root,task);const results=[];for(const name of checksFor(task).map(c=>c.id)){const r=await endpoint(root,name,task);results.push(r);assert.equal(r.exitCode,0,task.id+' '+name+'\n'+r.stdout+'\n'+r.stderr);}
  await applyOfficial(root,task);for(const name of ['official','probe',...(task.id==='fetching-filters'?['compatibility']:[])]){const r=await endpoint(root,name,task);results.push(r);assert.equal(r.exitCode,0,task.id+' '+name+'\n'+r.stdout+'\n'+r.stderr);}
  await atomicJson(join(root,'results.json'),{results,before,negativeProbe,compatibilityBaseline,upstreamCompatibility});rows.push({task:task.id,baselineOfficial:before.exitCode,baselineProbe:negativeProbe.exitCode,compatibilityBaseline:compatibilityBaseline?.exitCode??null,upstreamCompatibility:upstreamCompatibility?.exitCode??null,positive:results.map(({stdout,stderr,...r})=>r)});console.log('CONTROL',task.id,'passed');
 }
 await atomicJson(join(work,'controls.json'),{complete:true,externalModelRequests:0,rows,sourceHashes:{controls:digest(await readFile(import.meta.filename))}},{exclusive:true});
}
