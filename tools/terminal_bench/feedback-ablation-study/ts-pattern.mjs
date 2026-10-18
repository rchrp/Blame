// Fresh-project fixture and researcher controls. Control source is never copied to workers.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,symlink,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {prepareIsolatedNodeEnvironment} from '../isolated-node-environment.mjs';
import {atomicJson as save} from '../durable-campaign.mjs';
const repo=resolve(import.meta.dirname,'../../..'),deps=join(repo,'.blame/research/validation-scope-f44/dependencies');
const archive='/workspace/blame-study-runs/feedback-confirmation-inputs/ts-pattern.tar.gz';
const common=' Work only in this checkout; do not retrieve remote history, solutions or previous study artifacts. Do not install dependencies. Preserve original tests, manifests, locks, configuration and supplied checks. Preserve public types and unrelated behavior. Add new src/*.test.ts tests for the request. After the final source or test edit run npm run test:study:regression, npm run test:study:types and npm run test:study:delivered. Source compilation excludes tests; typecheck:delivered checks new tests. Report exact commands, results and limits honestly.';
export const confirmationTasks=[
 {id:'alternative-selections',request:'Fix selection leakage from failed alternatives in multi-pattern match(...).with(...) and P.union. Only the first successful alternative may contribute selected values. P.union must still initialize keys belonging only to other alternatives to undefined, and a total mismatch must not leak a partial selection. Add one shared internal transactional matching helper and use it in both the match-expression and union paths. Preserve first-match short-circuiting, named and anonymous selection, and guard behavior.'},
 {id:'symbol-pattern-keys',request:'Make selection-key discovery traverse all own keys of an ordinary object pattern, including symbols and non-enumerable properties, consistently with object matching. Ignore inherited pattern keys, retain current inherited value-property matching behavior, and preserve matcher and tuple special cases. Centralize object-pattern own-key enumeration in a new internal module used by both ordinary object matching and selection-key discovery. This must make absent optional object patterns and empty arrays initialize selections nested under symbol/non-enumerable keys correctly.'},
 {id:'empty-collection-selections',request:'Make empty P.set(subpattern) and P.map(keyPattern,valuePattern) initialize every declared selection to a fresh empty array, consistently with P.array(subpattern). Include nested named and anonymous selections, duplicate key names and both map key/value patterns. Keep no-argument collection matching and non-empty collection ordering unchanged. Centralize empty-selection initialization in a shared internal helper used by array, set and map. Do not snapshot mutable selection arrays across invocations.'}
].map(t=>({...t,project:'ts-pattern',selected:[],instruction:t.request+common,requiredChecks:['regression','types','delivered'].map(id=>({id,task:'test:study:'+id}))}));
export async function prepare(root,id,isolated=false){
 const task=confirmationTasks.find(t=>t.id===id);assert.ok(task);
 await mkdir(root,{recursive:true});execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',root]);
 if(isolated){const environment=await prepareIsolatedNodeEnvironment({baselineModules:join(deps,'node_modules'),workspace:root,cacheRoot:resolve(root,'../npm-cache')});environment.env.PATH=join(root,'node_modules/.bin')+':'+process.env.PATH;
  const shellPath=resolve(root,'../shell-environment.sh'),q=x=>"'"+x.replaceAll("'","'\\''")+"'",shell=Object.entries(environment.env).map(([k,v])=>'export '+k+'='+q(v)).join('\n')+'\n';
  await writeFile(shellPath,shell);environment.env.BASH_ENV=shellPath;environment.shellEnvironmentSha256=createHash('sha256').update(shell).digest('hex');await save(resolve(root,'../environment.json'),environment);
 }else await symlink(join(deps,'node_modules'),join(root,'node_modules'));
 await mkdir(join(root,'.study'));
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));pkg.packageManager='npm@11.6.4';
 Object.assign(pkg.scripts,{'test:study:regression':'node node_modules/vitest/vitest.mjs run --config .study/vitest.config.mjs','test:study:types':'node node_modules/typescript/bin/tsc --noEmit -p .study/tsconfig.json','test:study:delivered':'node .study/delivered.mjs runtime','typecheck:delivered':'node .study/delivered.mjs types'});await save(join(root,'package.json'),pkg);
 await save(join(root,'.study/task.json'),{...task,sourceRoot:'src',originalTests:[]});
 await save(join(root,'.study/tsconfig.json'),{compilerOptions:{strict:true,noEmit:true,target:'ES2022',lib:['ESNext','DOM'],module:'ESNext',moduleResolution:'Bundler',allowImportingTsExtensions:true,skipLibCheck:true,types:['node']},include:['../src/**/*.ts'],exclude:['../src/**/*.test.ts']});
 await writeFile(join(root,'.study/vitest.config.mjs'),'export default '+JSON.stringify({test:{include:['tests/is-matching.test.ts','tests/optional.test.ts','tests/maps.test.ts','tests/sets.test.ts','tests/intersection-and-union.test.ts'],globals:true,maxWorkers:1,fileParallelism:false,cache:false}})+';\n');
 await cp(join(import.meta.dirname,'ts-pattern-delivered.mjs'),join(root,'.study/delivered.mjs'));
 execFileSync('git',['init','--quiet'],{cwd:root});await writeFile(join(root,'.git/info/exclude'),'.blame/\nnode_modules/\n');execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['add','-f','.study'],{cwd:root});execFileSync('git',['-c','user.name=Study','-c','user.email=study@example.invalid','commit','--quiet','-m','Frozen TS-Pattern cross-module input'],{cwd:root,env:{...process.env,GIT_AUTHOR_DATE:'2026-10-18T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-18T00:00:00Z'}});
}
export function check(root,name,id){
 const external=name==='feature',command=external?process.execPath:'npm';
 const argv=external?['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(import.meta.dirname,'ts-pattern-oracle.mjs'),root,id]:['run',name==='delivered-types'?'typecheck:delivered':'test:study:'+name];
 const start=performance.now(),r=spawnSync(command,argv,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,TZ:'UTC',PATH:join(root,'node_modules/.bin')+':'+process.env.PATH,npm_config_offline:'true',npm_config_update_notifier:'false'}});
 return {name,command,argv,exitCode:r.status,signal:r.signal,error:r.error?.code??null,durationMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr};
}
export async function positive(root,id){
 const read=p=>readFile(join(root,'src',p),'utf8'),put=(p,s)=>writeFile(join(root,'src',p),s);
 if(id==='alternative-selections'){
  let helpers=await read('internals/helpers.ts');helpers+=`\nexport const transactionalMatch = (pattern: any, value: any, select: (key: string, value: unknown) => void): boolean => {\n const staged: [string, unknown][]=[];\n const matched=matchPattern(pattern,value,(key,value)=>staged.push([key,value]));\n if(matched)for(const [key,value] of staged)select(key,value);\n return matched;\n};\n`;await put('internals/helpers.ts',helpers);
  let m=await read('match.ts');m=m.replace("import { matchPattern }",'import { transactionalMatch }').replace('matchPattern(pattern, this.input, select)','transactionalMatch(pattern, this.input, select)');await put('match.ts',m);
  let p=await read('patterns.ts');p=p.replace('import { matchPattern,','import { transactionalMatch, matchPattern,');p=p.replace("const matched = (patterns as readonly UnknownPattern[]).some((p) =>\n          matchPattern(p, value, selector)","const matched = (patterns as readonly UnknownPattern[]).some((p) =>\n          transactionalMatch(p, value, selector)");await put('patterns.ts',p);
 }else if(id==='symbol-pattern-keys'){
  await put('internals/pattern-keys.ts','export const patternKeys = (pattern: object): (string | symbol)[] => Reflect.ownKeys(pattern);\n');
  let h=await read('internals/helpers.ts');h="import {patternKeys} from './pattern-keys';\n"+h;h=h.replace('Reflect.ownKeys(pattern).every','patternKeys(pattern).every').replace('flatMap(Object.values(pattern), getSelectionKeys)','flatMap(patternKeys(pattern).map(key => pattern[key]), getSelectionKeys)');await put('internals/helpers.ts',h);
 }else{
  let h=await read('internals/helpers.ts');h+=`\nexport const emptySelections = (...patterns: any[]): Record<string, unknown[]> => { const selections: Record<string, unknown[]>={};for(const pattern of patterns)for(const key of getSelectionKeys(pattern))selections[key]=[];return selections; };\n`;await put('internals/helpers.ts',h);
  let p=await read('patterns.ts');p=p.replace('import { matchPattern,','import { emptySelections, matchPattern,');
  p=p.replace("getSelectionKeys(pattern).forEach((key) => {\n              selections[key] = [];\n            });","selections = emptySelections(pattern);");
  const setStart=p.indexOf('export function set<input>'),mapStart=p.indexOf('export function map<input>');
  p=p.slice(0,setStart)+p.slice(setStart,mapStart).replace('if (value.size === 0) {\n            return { matched: true, selections };','if (value.size === 0) {\n            selections=emptySelections(...args);\n            return { matched: true, selections };')+p.slice(mapStart).replace('if (value.size === 0) {\n            return { matched: true, selections };','if (value.size === 0) {\n            selections=emptySelections(...args);\n            return { matched: true, selections };');await put('patterns.ts',p);
 }
 const test=id==='alternative-selections'?`expect(match<{a:number;b:number}>({a:1,b:2}).with(P.union({a:P.select('discard'),b:0},{a:1,b:P.select('keep')}),x=>x).run()).toEqual({discard:undefined,keep:2});`:
 id==='symbol-pattern-keys'?`const k=Symbol();expect(match<unknown>(undefined).with(P.optional({[k]:P.select('x')}),x=>x).run()).toEqual({x:undefined});`:
 `expect(match(new Set<number>()).with(P.set(P.select('x')),x=>x).run()).toEqual({x:[]});`;
 await put('confirmation.test.ts',"import {test,expect} from 'vitest';import {P,match} from './index';test('requested behavior',()=>{"+test+"});\n");
}
export async function negative(root,id){
 const file=id==='symbol-pattern-keys'?'internals/helpers.ts':'patterns.ts',path=join(root,'src',file);let s=await readFile(path,'utf8');
 if(id==='alternative-selections')s=s.replace('transactionalMatch(p, value, selector)','matchPattern(p, value, selector)');
 else if(id==='symbol-pattern-keys')s=s.replace('flatMap(patternKeys(pattern).map(key => pattern[key]), getSelectionKeys)','flatMap(Object.values(pattern), getSelectionKeys)');
 else s=s.replaceAll('selections=emptySelections(...args);','selections={};');
 await writeFile(path,s);
}
