// Hidden endpoint oracle: never copied to a measured worker workspace.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const root=process.argv[2],task=process.argv[3];
const load=p=>import(pathToFileURL(join(root,p)).href);
if(task==='request-correlation'){
 const {createRequestContext}=await load('packages/request/src/context.ts');const {handleRequest}=await load('apps/api/src/request.ts');const {withCorrelation}=await load('packages/request/src/logger.ts');
 const cases=[[{},'fallback'],[{'X-CoRrElAtIoN-Id':'  Abc._-09  '},'Abc._-09'],[{'x-correlation-id':['one']},'one'],[{'x-correlation-id':['one','two']},'fallback'],[{'x-correlation-id':[]},'fallback'],[{'x-correlation-id':'_bad'},'fallback'],[{'x-correlation-id':'a'.repeat(64)},'a'.repeat(64)],[{'x-correlation-id':'a'.repeat(65)},'fallback'],[{'x-correlation-id':'a\nb'},'fallback'],[{'x-correlation-id':'é'},'fallback'],[{'x-correlation-id':'a','X-Correlation-Id':'b'},'fallback'],[{'x-correlation-id':undefined},'fallback']];
 for(const [headers,want]of cases){const before=structuredClone(headers);assert.deepEqual(createRequestContext(headers,'fallback'),{correlationId:want});const fields={correlationId:'old',extra:0};const response=handleRequest(headers,'fallback',fields);assert.equal(response.status,200);assert.equal(response.body.message,'ok');assert.equal(response.headers['x-correlation-id'],want);assert.equal(response.body.correlationId,want);assert.equal(response.log.correlationId,want);assert.equal(response.log.extra,0);assert.deepEqual(headers,before);assert.deepEqual(fields,{correlationId:'old',extra:0});}
 const fields=Object.freeze({correlationId:'old',nested:Object.freeze({x:1})});const enriched=withCorrelation(fields,'new');assert.equal(enriched.nested,fields.nested);assert.equal(enriched.correlationId,'new');
}else if(task==='csv-export-options'){
 const {createCsvExporter,encodeCell}=await load('packages/export/src/index.ts');const {exportReport}=await load('apps/api/src/export.ts');
 const captured=Object.freeze({delimiter:';',newline:'\r\n',includeHeader:true});const override=Object.freeze({delimiter:',',includeHeader:false,newline:undefined});const columns=Object.freeze(['h;1','quote"']);const rows=Object.freeze([Object.freeze([0,false]),Object.freeze(['a;b','x"y']),Object.freeze(['\n',null])]);
 const csv=createCsvExporter(columns,captured);assert.equal(csv(rows),'"h;1";"quote"""\r\n0;false\r\n"a;b";"x""y"\r\n"\n";');assert.equal(csv(rows,override),'0,false\r\na;b,"x""y"\r\n"\n",');assert.equal(csv([[undefined,'r\rc']]),'"h;1";"quote"""\r\n;"r\rc"');
 assert.equal(createCsvExporter(['a'])([[1]],{includeHeader:false}),'1');assert.equal(exportReport(['x'],[['a;b']],{delimiter:';',includeHeader:false}).body,'"a;b"');assert.equal(encodeCell(false,','),'false');assert.equal(encodeCell(0,','),'0');
 for(const delimiter of ['',',;','"','\r','\n','😀'])assert.throws(()=>createCsvExporter(['a'],{delimiter})([[1]]),RangeError);for(const newline of ['','x','\r'])assert.throws(()=>createCsvExporter(['a'],{newline})([[1]]),RangeError);
 assert.throws(()=>csv([[1]],{delimiter:''}),RangeError);assert.equal(csv([[1]],{delimiter:undefined,includeHeader:undefined}),'"h;1";"quote"""\r\n1');
}else if(task==='auth-expiry-contract'){
 const {authenticate,AuthError}=await load('packages/security/src/index.ts');const {authorize}=await load('apps/api/src/authorize.ts');
 const check=(token,now,skew,code)=>{assert.throws(()=>authenticate(token,now,skew),e=>e instanceof AuthError&&e instanceof Error&&e.name==='AuthError'&&e.code===code&&typeof e.message==='string');assert.equal(authorize(token,now,skew).status,401);assert.equal(authorize(token,now,skew).body.code,code);};
 assert.deepEqual(authenticate({subject:'u'},999999,0),{subject:'u'});assert.deepEqual(authenticate(Object.freeze({subject:'u',expiresAt:10}),9999,0),{subject:'u'});check({subject:'u',expiresAt:10},10000,0,'expired_token');assert.deepEqual(authenticate({subject:'u',expiresAt:10},10000,1),{subject:'u'});check({subject:'u',expiresAt:10},11000,1,'expired_token');check({subject:'',expiresAt:20},0,0,'invalid_token');
 for(const expiresAt of [NaN,Infinity,-1,'10',null])check({subject:'u',expiresAt},0,0,'invalid_token');for(const now of [NaN,Infinity,-1]){assert.throws(()=>authenticate({subject:'u'},now),RangeError);assert.throws(()=>authorize({subject:'u'},now),RangeError);}for(const skew of [NaN,Infinity,-1])assert.throws(()=>authorize({subject:'u'},0,skew),RangeError);
 assert.deepEqual(authorize({subject:'u',expiresAt:1},0),{status:200,body:{subject:'u'}});const boom=new Error('sentinel');assert.throws(()=>authorize({get subject(){throw boom;}}),e=>e===boom);
}else throw Error('Unknown task '+task);
const typeSource=task==='csv-export-options'?`import {createCsvExporter} from '../packages/export/src/index.ts';
import type {CsvOptions} from '../packages/export/src/index.ts';
const options:CsvOptions={includeHeader:false,delimiter:undefined};
const result:string=createCsvExporter(['x'])([[1]],options);
void result;
`:task==='auth-expiry-contract'?`import {authenticate,AuthError} from '../packages/security/src/index.ts';
import type {AuthErrorCode} from '../packages/security/src/index.ts';
const code:AuthErrorCode='expired_token';const error=new AuthError('expired',code);
// @ts-expect-error code is readonly
error.code='invalid_token';
const result:{subject:string}=authenticate({subject:'u',expiresAt:undefined},0,1);void result;
`:`import {createRequestContext} from '../packages/request/src/index.ts';
const result:{correlationId:string}=createRequestContext({'X-Correlation-Id':['x'] as const},'fallback');void result;
`;
await mkdir(join(root,'.blame'),{recursive:true});await writeFile(join(root,'.blame/hidden-contract.ts'),typeSource);
const compiler=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
await writeFile(join(root,'.blame/hidden-contract.json'),JSON.stringify({compilerOptions:compiler.compilerOptions,files:['hidden-contract.ts']}));
const types=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p',join(root,'.blame/hidden-contract.json')],{cwd:root,encoding:'utf8',timeout:60000});
assert.equal(types.status,0,types.stdout+types.stderr);
console.log('Hidden behavioral and public type contracts passed:',task);
