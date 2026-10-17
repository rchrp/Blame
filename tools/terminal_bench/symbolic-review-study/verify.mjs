import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const path=resolve(process.argv[2]),data=JSON.parse(await readFile(path,'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(data.modelRequests,0);assert.equal(data.rows.length,12);
for(const{sha256,content}of Object.values(data.sources))assert.equal(sha(content),sha256);
assert.equal(data.rows.reduce((sum,row)=>sum+row.concreteInputsChecked,0),85);
for(const row of data.rows){
 assert.equal(row.analysis.sourceSha256,sha(row.request.source));
 assert.equal(row.analysis.assertion,row.request.assertion);
 assert.equal(row.analysis.status,row.concreteViolations?'counterexample':'bounded_no_counterexample');
 assert.equal(row.analysis.validationAdmission,false);
 assert.match(row.analysis.solver.version,/^Z3 version /);
 if(row.analysis.witness)assert.equal(row.analysis.witness.concretelyReproduced,true);
}
for(const row of data.adverse){assert.equal(row.after.status,'unknown');assert.equal(row.after.solver,undefined);assert.equal(row.after.validationAdmission,false);}
console.log(JSON.stringify({path,verified:true,modelRequests:0,fixtures:12,concreteInputs:85,adverseRejected:data.adverse.length}));
