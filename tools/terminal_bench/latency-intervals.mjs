import {intervalMs, intersectionMs, mergeIntervals} from './request-timing.mjs';

export function toolIntervals(events) {
  const starts=new Map(), intervals=[], anomalies=[];
  for (const [index,row] of events.entries()) {
    const e=row.event??row,p=e.payload??{};if(e.type!=='tool')continue;
    const id=p.toolCallId??p.toolCall?.id;
    const at=Date.parse(p.timestamp??row.recordedAt);
    if(p.phase==='started') {
      if(starts.has(id))anomalies.push({index,reason:'duplicate_tool_start'});
      starts.set(id,{index,at});
    } else if(p.phase==='finished') {
      const start=starts.get(id);starts.delete(id);
      if(!start||!Number.isFinite(start.at)||!Number.isFinite(at)||at<start.at)anomalies.push({index,reason:'unmatched_or_invalid_tool_span'});
      else intervals.push([start.at,at]);
    }
  }
  for(const {index}of starts.values())anomalies.push({index,reason:'unfinished_tool'});
  return {intervals,anomalies};
}

export function requestIntervals(records) {
  const attempts=new Map(),anomalies=[];
  for(const [index,r]of records.entries()) {
    const at=r.timeOriginMs+r.monotonicMs;
    if(!Number.isSafeInteger(r.attempt)||!Number.isFinite(at)){anomalies.push({index,reason:'invalid_timing_record'});continue;}
    const key=JSON.stringify([r.timeOriginMs,r.attempt]);
    let a=attempts.get(key);
    if(!a){a={attempt:r.attempt,requestBodySha256:r.requestBodySha256,events:[],complete:false};attempts.set(key,a);}
    a.events.push({event:r.event,at});
  }
  const intervals=[],phases={headers:[],firstRead:[],bodyTail:[]};
  for(const a of attempts.values()) {
    const starts=a.events.filter(x=>x.event==='fetch_started');
    const terminal=a.events.filter(x=>['fetch_error','body_absent','body_end','body_error','body_cancelled','body_unobserved'].includes(x.event));
    if(starts.length!==1||terminal.length!==1||a.events.some((x,i)=>i&&x.at<a.events[i-1].at)||terminal[0]?.at<starts[0]?.at){anomalies.push({attempt:a.attempt,reason:'incomplete_or_invalid_request_span'});continue;}
    a.complete=true;a.terminal=terminal[0].event;intervals.push([starts[0].at,terminal[0].at]);
    const headers=a.events.find(x=>x.event==='response_headers'),first=a.events.find(x=>x.event==='first_body_read');
    if(headers)phases.headers.push([starts[0].at,headers.at]);
    if(headers&&first)phases.firstRead.push([headers.at,first.at]);
    if(first)phases.bodyTail.push([first.at,terminal[0].at]);
  }
  return {attempts:[...attempts.values()],intervals,phases,anomalies};
}

export function timingPartition(start,end,tools,requests=[]) {
  const clip=xs=>xs.map(([a,b])=>[Math.max(start,a),Math.min(end,b)]).filter(([a,b])=>b>=a);
  const t=clip(tools),r=clip(requests),toolMs=intervalMs(t),requestMs=intervalMs(r),overlapMs=intersectionMs(t,r);
  return {windowMs:end-start,toolMs,requestMs,overlapMs,toolOnlyMs:toolMs-overlapMs,requestOnlyMs:requestMs-overlapMs,
    outsideObservedSpansMs:end-start-intervalMs([...t,...r]),toolSpanCount:tools.length,toolUnionCount:mergeIntervals(t).length};
}

export function requestTimingObservation(records,wire){
  const parsed=requestIntervals(records),queues=new Map();
  for(const a of parsed.attempts){const q=queues.get(a.requestBodySha256)??[];q.push(a);queues.set(a.requestBodySha256,q);}
  let matched=parsed.attempts.length===wire.length;
  const attempts=wire.map(w=>{const a=queues.get(w.requestBodySha256)?.shift();if(!a){matched=false;return null;}
    return {attempt:a.attempt,requestBodySha256:a.requestBodySha256,forwarded:!w.budgetRejected,complete:a.complete,terminal:a.terminal??null};});
  if([...queues.values()].some(q=>q.length))matched=false;
  return {matched,attempts,anomalies:parsed.anomalies,meaning:'Unfinished consumer streams remain incomplete; timeout/cancellation are not silently replaced with successful EOF. Exact request hashes/counts join the wire audit, not invoices.'};
}
