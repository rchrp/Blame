// Execute unchanged Mocha callback cases through Vitest, retaining failures/timeouts.
import {it} from 'vitest';
function adapt(run){
 return (name,fn,timeout)=>run(name,typeof fn==='function'&&fn.length>0?()=>new Promise((resolve,reject)=>{
  let called=false;
  const done=error=>{if(called)throw Error('done called more than once');called=true;error?reject(error):resolve();};
  fn.call({timeout(){}},done);
 }):fn,timeout);
}
const bridged=adapt(it);bridged.skip=adapt(it.skip);bridged.only=adapt(it.only);bridged.todo=it.todo;
globalThis.it=bridged;globalThis.specify=bridged;globalThis.xit=bridged.skip;
