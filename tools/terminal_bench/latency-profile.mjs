// Offline interval accounting; never infer model inference or pure network time.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {toolIntervals,requestIntervals,timingPartition} from './latency-intervals.mjs';
const campaign=process.argv[2],output=process.argv[3];assert.ok(campaign&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8'));
const lines=async p=>(await readFile(p,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const analysis=await read(join(campaign,'analysis.json')),rows=[];
for(const row of analysis.rows) {
  const root=join(campaign,row.name),result=await read(join(root,'result.json')),events=await lines(join(root,'events.jsonl'));
  const tools=toolIntervals(events);let records=null;
  try{records=await lines(join(root,'request-timing.jsonl'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const requests=records?requestIntervals(records):null;
  const start=Date.parse(result.startedAt),end=Date.parse(result.finishedAt);assert.ok(Number.isFinite(start)&&end>=start);
  const partition=timingPartition(start,end,tools.intervals,requests?.intervals);
  if(!requests)for(const key of ['requestMs','overlapMs','toolOnlyMs','requestOnlyMs'])partition[key]=null;
  rows.push({name:row.name,arm:row.arm,sdkDurationMs:result.durationMs,
    sourceHashes:{events:sha(await readFile(join(root,'events.jsonl'))),result:sha(await readFile(join(root,'result.json'))),...(records?{requestTiming:sha(await readFile(join(root,'request-timing.jsonl')))}:{})},
    ...partition,toolAnomalies:tools.anomalies,requestAnomalies:requests?.anomalies??null,
    measuredRequests:requests?.attempts.map(a=>({attempt:a.attempt,requestBodySha256:a.requestBodySha256,complete:a.complete,terminal:a.terminal??null}))??null,
    requestPhaseUnionMs:requests?Object.fromEntries(Object.entries(requests.phases).map(([k,v])=>[k,timingPartition(start,end,[],v).requestMs])):null});
}
const numeric=['sdkDurationMs','windowMs','toolMs','requestMs','overlapMs','toolOnlyMs','requestOnlyMs','outsideObservedSpansMs'];
const arms=Object.fromEntries(['reference','candidate','cline'].map(arm=>[arm,Object.fromEntries(numeric.map(k=>[k,rows.filter(r=>r.arm===arm).every(r=>Number.isFinite(r[k]))?rows.filter(r=>r.arm===arm).reduce((n,r)=>n+r[k],0):null]))]));
await writeFile(output,JSON.stringify({method:'Recorded tool start/end intervals clipped to SDK worker bounds, merged before summing. Historical absent fetch spans are unknown, not zero requests. New fetch spans end on consumer-driven EOF/cancellation/error; they include gateway, transport, generation and client processing/backpressure, not pure network or provider inference. Tool/HTTP overlaps are explicit. Record timestamps and passive observer overhead do not establish exclusive-host causality. Historical diagnosis is post-hoc; original outcomes/costs unchanged.',rows,arms},null,2)+'\n');
console.log(JSON.stringify(arms));
