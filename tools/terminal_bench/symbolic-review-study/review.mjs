// Independent local cross-check against real JavaScript on researcher-written fixtures.
// node --import <tsx-loader> review.mjs <symbolic-analysis.ts> <z3> <new-output.json>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const modulePath=resolve(process.argv[2]),solverPath=resolve(process.argv[3]),output=resolve(process.argv[4]);
await access(output).then(()=>{throw Error('Refusing to overwrite review');},error=>{if(error.code!=='ENOENT')throw error;});
const sha=value=>createHash('sha256').update(value).digest('hex'),directory=dirname(modulePath),sources={};
for(const name of ['symbolic-analysis','symbolic-program','symbolic-expression','symbolic-solver','symbolic-types']){
 const path=join(directory,name+'.ts'),content=await readFile(path,'utf8');sources[path]={sha256:sha(content),content};
}
const {analyzeSymbolicSource}=await import(pathToFileURL(modulePath));
const {compileSymbolicProgram}=await import(pathToFileURL(join(directory,'symbolic-program.ts')));
const integers={x:{min:-2,max:2}},mixed={...integers,enabled:{type:'boolean'}};
const cases=[
 ['identity','function choose(x:number){return x;}','result === x',integers],
 ['square','function choose(x:number){return x*x;}','result >= 0',integers],
 ['bad branch','function choose(x:number){if(x<0)return x-1;return x+1;}','result > x',integers],
 ['branch locals','function choose(x:number,enabled:boolean){const delta=2;if(enabled){const y=x+delta;return y;}return x-delta;}','enabled ? result === x+2 : result === x-2',mixed],
 ['nonreturning nested block','function choose(x:number,enabled:boolean){const y=x+1;{const z=y*2;if(enabled)return z;}return y;}','enabled ? result === 2*(x+1) : result === x+1',mixed],
 ['nested conditions','function choose(x:number,enabled:boolean){if(enabled){if(x>0)return x;return -x;}return x+1;}','enabled ? result >= 0 : result > x',mixed],
 ['boolean arrow','const choose=(x:number,enabled:boolean)=>!(enabled && x>0);','result === (!enabled || x<=0)',mixed],
 ['nonlinear identity','function choose(x:number){return (x-1)*(x+1);}','result === x*x-1',integers],
 ['unary integers','function choose(x:number){return -(-x) + +x;}','result === 2*x',integers],
 ['declaration order','function choose(x:number){const y=x+1,z=y*x;return z;}','result === x*x+x',integers],
 ['boolean ternary','const choose=(x:number,enabled:boolean)=>enabled ? x>0 : x<=0;','result === (enabled ? x>0 : x<=0)',mixed],
 ['constant violation','function choose(x:number){const y=0;return y;}','result > x',integers],
];
const rows=[];
for(const[name,source,assertion,inputs]of cases){
 const request={source,functionName:'choose',inputs,assertion,solverPath},program=compileSymbolicProgram(request);
 const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const fn=runInNewContext(javascript+'\nchoose;'),names=Object.keys(inputs);
 const tuples=names.reduce((acc,name)=>acc.flatMap(row=>(inputs[name].type==='boolean'?[false,true]:Array.from({length:inputs[name].max-inputs[name].min+1},(_,n)=>n+inputs[name].min)).map(value=>({...row,[name]:value}))),[{}]);
 let violations=0;
 for(const values of tuples){const result=fn(...names.map(name=>values[name])),property=runInNewContext(assertion,{...values,result});
  assert.deepEqual(program.reproduce(values),{result,assertion:property},name);if(!property)violations++;
 }
 const analysis=await analyzeSymbolicSource(request);
 assert.equal(analysis.status,violations?'counterexample':'bounded_no_counterexample',name);
 if(analysis.witness){const values=analysis.witness.inputs,result=fn(...names.map(name=>values[name]));
  assert.equal(result,analysis.witness.result,name);assert.equal(runInNewContext(assertion,{...values,result}),false,name);
 }
 rows.push({name,request:{...request,solverPath:undefined},concreteInputsChecked:tuples.length,concreteViolations:violations,analysis});
}
const adverse=[
 {name:'ambient function body erased',source:'declare function choose(x:number){return x;}',inputs:integers,assertion:'result === x',before:'Prototype returned bounded_no_counterexample; TypeScript erases the declaration and real JavaScript has no choose binding.'},
 {name:'ambient arrow erased',source:'declare const choose=(x:number)=>x;',inputs:integers,assertion:'result === x',before:'Same ambient-erasure mechanism; shape must remain unsupported.'},
 {name:'this pseudo parameter',source:'function choose(this:number,x:number){return x;}',inputs:{this:{min:0,max:1},x:{min:0,max:1}},assertion:'result === x',before:'Prototype counted the erased TypeScript this pseudo-parameter as an ordinary scalar input.'},
 {name:'assertion wrapper escape',source:'function choose(x:number){return x;}',inputs:integers,assertion:'true); //',before:'Prototype accepted an assertion that terminated the wrapper declaration; it was not an expression-only contract.'},
 {name:'escaped class binding collision',source:'function choose(x:number){return x;} class '+String.fromCharCode(92)+'u0063hoose {}',inputs:integers,assertion:'result === x',before:'Prototype compared class name source spelling rather than normalized AST identifier text, missing the duplicate binding.'},
 {name:'import-equals binding collision',source:"import choose = require('./external'); function choose(x:number){return x;}",inputs:integers,assertion:'result === x',before:'Prototype did not scan ImportEqualsDeclaration bindings when refusing ambiguous target names.'},
];
for(const row of adverse){row.after=await analyzeSymbolicSource({...row,functionName:'choose',solverPath});assert.equal(row.after.status,'unknown',row.name);assert.equal(row.after.solver,undefined,row.name);}
for(const[path,{sha256}]of Object.entries(sources))assert.equal(sha(await readFile(path)),sha256,'Engine changed during independent review');
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({modelRequests:0,method:'Post-hoc independent local review of the new prototype, before any model campaign. Twelve constructed supported fixtures compare the source AST interpreter and real Z3 against transpiled JavaScript on every finite input. Adversarial shape/assertion/name-resolution cases must remain unknown. Initial adverse observations preceded hardening and were not byte-bound replays; post-hardening controls bind the exact source contents below. This is no global success/efficiency claim.',sources,typescriptVersion:ts.version,rows,adverse},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,fixtures:rows.length,inputs:rows.reduce((n,row)=>n+row.concreteInputsChecked,0),adverseRejected:adverse.length,modelRequests:0}));
