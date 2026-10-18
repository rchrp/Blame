import assert from 'node:assert/strict';
import test from 'node:test';
import {createTimedFetch, mergeIntervals, intervalMs, intersectionMs} from './request-timing.mjs';
import {requestIntervals, requestTimingObservation, timingPartition, toolIntervals} from './latency-intervals.mjs';

const input = 'https://example.invalid/v1/responses';
const body = JSON.stringify({model:'fixed',input:[]});
function observer(fetch) { const records=[]; let tick=0; return {records,fetch:createTimedFetch(fetch,{record:v=>records.push(v),now:()=>++tick,timeOrigin:1000})}; }

test('observes consumer demand without eager reads, buffering or request changes',async()=>{
  let pulls=0; const init={method:'POST',body,headers:{authorization:'credential-never-save'},signal:new AbortController().signal};
  const stream=new ReadableStream({pull(c){pulls++;if(pulls===1)c.enqueue(new TextEncoder().encode('é'));else c.close();}},{highWaterMark:0});
  const {fetch,records}=observer(async (url,args)=>{assert.equal(url,input);assert.equal(args,init);return new Response(stream,{headers:{'content-type':'text/plain'}});});
  const response=await fetch(input,init);
  await Promise.resolve();assert.equal(pulls,0);assert.equal(response.bodyUsed,false);
  assert.deepEqual(records.map(x=>x.event),['fetch_started','response_headers']);
  assert.equal(await response.text(),'é');assert.equal(response.bodyUsed,true);
  assert.deepEqual(records.map(x=>x.event),['fetch_started','response_headers','first_body_read','body_end']);
  assert.equal(records.at(-1).readBytes,2);assert.equal(JSON.stringify(records).includes('credential'),false);
  assert.equal(JSON.stringify(records).includes('é'),false);assert.equal(records[0].requestBytes,Buffer.byteLength(body));
});
test('preserves JSON, status, response metadata and clone semantics',async()=>{
  const original=new Response('{"ok":true}',{status:201,statusText:'Created',headers:{'x-test':'same'}});
  for(const [key,value]of Object.entries({url:input,redirected:true,type:'basic'}))Object.defineProperty(original,key,{value});
  const {fetch}=observer(async()=>original);const response=await fetch(input,{body});const clone=response.clone();
  for(const value of [response,clone]){assert.equal(value.url,input);assert.equal(value.status,201);assert.equal(value.statusText,'Created');assert.equal(value.redirected,true);assert.equal(value.type,'basic');assert.equal(value.headers.get('x-test'),'same');assert.deepEqual(await value.json(),{ok:true});}
});
test('preserves cancellation before consumption, without leaking reasons',async()=>{
  let reason;const original=new Response(new ReadableStream({cancel(r){reason=r;}},{highWaterMark:0}));
  const {fetch,records}=observer(async()=>original);const response=await fetch(input,{body});await response.body.cancel('secret cancellation reason');
  assert.equal(reason,'secret cancellation reason');assert.equal(records.at(-1).event,'body_cancelled');assert.equal(records.at(-1).readBytes,0);assert.equal(JSON.stringify(records).includes('secret'),false);
});
test('preserves transport rejection and aborted signal; never saves error text',async()=>{
  const controller=new AbortController();controller.abort();const error=new Error('secret failure');
  const {fetch,records}=observer(async(_url,init)=>{assert.equal(init.signal,controller.signal);throw error;});
  await assert.rejects(fetch(input,{body,signal:controller.signal}),e=>e===error);
  assert.equal(records.at(-1).event,'fetch_error');assert.equal(records.at(-1).aborted,true);assert.equal(JSON.stringify(records).includes('secret'),false);
});
test('body failure remains a failure, never a drained response',async()=>{
  const error=new Error('secret body');const {fetch,records}=observer(async()=>new Response(new ReadableStream({pull(c){c.error(error);}},{highWaterMark:0})));
  await assert.rejects((await fetch(input,{body})).text(),e=>e===error);assert.equal(records.at(-1).event,'body_error');assert.equal(JSON.stringify(records).includes('secret'),false);
});
test('null bodies and ordinary authentication requests are distinct',async()=>{
  const {fetch,records}=observer(async()=>new Response(null,{status:204}));await fetch(input,{body});assert.equal(records.at(-1).event,'body_absent');
  const ordinary=observer(async()=>new Response('token'));assert.equal(await(await ordinary.fetch('https://example.invalid/auth',{body:'{}'})).text(),'token');assert.equal(ordinary.records.length,0);
});
test('identical requests keep distinct attempt IDs and unconsumed requests remain pending',async()=>{
  const {fetch,records}=observer(async()=>new Response('x'));await fetch(input,{body});await fetch(input,{body});
  assert.deepEqual(records.filter(x=>x.event==='fetch_started').map(x=>x.attempt),[1,2]);assert.equal(records.some(x=>x.event==='body_end'),false);
});
test('uninspectable Request body is not cloned or consumed for identification',async()=>{
  const request=new Request(input,{method:'POST',body});const {fetch,records}=observer(async received=>{assert.equal(received,request);assert.equal(request.bodyUsed,false);return new Response(null,{status:204});});
  await fetch(request);assert.equal(records[0].requestBodySha256,null);assert.equal(records[0].inspectable,false);assert.equal(request.bodyUsed,false);
});
test('overlapping intervals and intersections retain wall-time accounting',()=>{
  const tool=[[1,4],[2,5],[8,9]],network=[[0,3],[4,10]];
  assert.deepEqual(mergeIntervals(tool),[[1,5],[8,9]]);assert.equal(intervalMs(tool),5);assert.equal(intersectionMs(tool,network),4);
  assert.equal(intervalMs([[2,1],[NaN,3]]),0);assert.equal(intervalMs([...tool,...network]),10);
});
test('tool/request interval accounting keeps overlap, errors and missing completions explicit',()=>{
  const event=(phase,id,t)=>({recordedAt:new Date(t).toISOString(),event:{type:'tool',payload:{phase,toolCallId:id}}});
  const tools=toolIntervals([event('started','a',1),event('started','b',2),event('finished','a',4),event('finished','b',5),event('started','pending',6)]);
  assert.deepEqual(tools.intervals,[[1,4],[2,5]]);assert.equal(tools.anomalies[0].reason,'unfinished_tool');
  const record=(attempt,event,at)=>({attempt,event,monotonicMs:at,timeOriginMs:0,requestBodySha256:'fixed'});
  const requests=requestIntervals([record(1,'fetch_started',0),record(1,'response_headers',3),record(1,'first_body_read',4),record(1,'body_end',8),record(2,'fetch_started',9)]);
  assert.equal(requests.attempts[1].complete,false);assert.equal(requests.anomalies.length,1);
  assert.deepEqual(timingPartition(0,10,tools.intervals,requests.intervals),{windowMs:10,toolMs:4,requestMs:8,overlapMs:4,toolOnlyMs:0,requestOnlyMs:4,outsideObservedSpansMs:2,toolSpanCount:2,toolUnionCount:1});
});
test('partial reads preserve split UTF-8 and cancellation without prefetching the tail',async()=>{
  let pulls=0,reason;
  const {fetch,records}=observer(async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(Uint8Array.of(pulls===1?0xc3:0xa9));},cancel(r){reason=r;}},{highWaterMark:0})));
  const reader=(await fetch(input,{body})).body.getReader();assert.deepEqual((await reader.read()).value,Uint8Array.of(0xc3));
  assert.equal(pulls,1);await reader.cancel('stop');assert.equal(reason,'stop');assert.equal(pulls,1);assert.equal(records.at(-1).event,'body_cancelled');
  let i=0;const utf=observer(async()=>new Response(new ReadableStream({pull(c){if(i===0)c.enqueue(Uint8Array.of(0xc3));else if(i===1)c.enqueue(Uint8Array.of(0xa9));else c.close();i++;}},{highWaterMark:0})));
  assert.equal(await(await utf.fetch(input,{body})).text(),'é');
});
test('request-hash reconciliation distinguishes repeated, missing and unfinished attempts',()=>{
  const rec=(attempt,event,t)=>({attempt,event,timeOriginMs:0,monotonicMs:t,requestBodySha256:'same'});
  const records=[rec(1,'fetch_started',1),rec(1,'fetch_error',2),rec(2,'fetch_started',3)];
  const wire=[{requestBodySha256:'same',budgetRejected:true},{requestBodySha256:'same',budgetRejected:false}];
  const actual=requestTimingObservation(records,wire);assert.equal(actual.matched,true);assert.equal(actual.attempts[1].complete,false);
  assert.equal(actual.attempts[0].forwarded,false);assert.equal(actual.anomalies.length,1);
  assert.equal(requestTimingObservation(records,wire.slice(0,1)).matched,false);assert.equal(requestTimingObservation([],wire).matched,false);
});
