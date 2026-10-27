import {join} from 'node:path';
import {evidence, file} from './evidence.mjs';
import {study} from './inputs.mjs';
import {atomicJson} from '../durable-campaign.mjs';
import {intervalMs, intersectionMs} from '../request-timing.mjs';
const {records, executionFinished} = await evidence(), rows = [];
for (const c of records) {
  const lines = path => c.files[path] ? file(c, path).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const grouped = new Map();
  for (const e of lines('request-timing.jsonl')) {const a = grouped.get(e.attempt) ?? []; a.push(e); grouped.set(e.attempt, a);}
  const http = [], header = [], body = []; let unfinished = 0, abnormalEnds = 0;
  for (const events of grouped.values()) {
    const start = events.find(e => e.event === 'fetch_started'), headers = events.find(e => e.event === 'response_headers');
    const end = events.find(e => ['body_end','body_absent','body_cancelled','body_error','fetch_error'].includes(e.event));
    if (!start || !end) {unfinished++; continue;}
    if (!['body_end','body_absent'].includes(end.event)) abnormalEnds++;
    const ms = e => e.timeOriginMs + e.monotonicMs;
    http.push([ms(start), ms(end)]);
    if (headers) {header.push([ms(start), ms(headers)]); body.push([ms(headers), ms(end)]);}
  }
  const tools = [], started = new Map();
  for (const {event, recordedAt} of lines('events.jsonl')) {
    if (event?.type !== 'tool') continue;
    const p = event.payload, id = p.toolCallId ?? p.toolCall?.id;
    if (p.phase === 'started') started.set(id, Date.parse(recordedAt));
    else if (p.phase === 'finished' && started.has(id)) {tools.push([started.get(id), Date.parse(recordedAt)]); started.delete(id);}
  }
  const result = c.files['result.json'] ? JSON.parse(file(c, 'result.json')) : null;
  const bounds = result ? [[Date.parse(result.startedAt), Date.parse(result.finishedAt)]] : [];
  const toolMs = intervalMs(tools), httpMs = intervalMs(http), overlapMs = intersectionMs(tools, http);
  const outside = result && !unfinished && !started.size ? result.durationMs - toolMs - httpMs + overlapMs : null;
  rows.push({name: c.name, panel: c.row.panel, arm: c.row.arm, interrupted: !!c.partial,
    sdkMs: result?.durationMs ?? null, observedHttpMs: httpMs, observedHeaderMs: intervalMs(header), observedBodyMs: intervalMs(body),
    observedToolUnionMs: toolMs, observedOverlapMs: overlapMs, outsideObservedMs: outside,
    sourceObserverMs: c.row.sourceAuditObservationMs, unfinishedRequests: unfinished, unfinishedTools: started.size, abnormalEnds,
    boundedHttpMs: result ? intersectionMs(http, bounds) : null,
    anomalies: [outside !== null && outside < -20 ? 'negative outside interval' : null].filter(Boolean)});
}
const groups = [];
for (const panel of ['F72']) for (const arm of ['reference','wait','cline']) {
  const r = rows.filter(r => r.panel === panel && r.arm === arm); if (!r.length) continue;
  const sum = field => r.every(x => x[field] !== null) ? r.reduce((n, x) => n + x[field], 0) : null;
  groups.push({panel, arm, assignments: r.length, sdkMs: sum('sdkMs'), observedHttpMs: sum('observedHttpMs'),
    observedToolUnionMs: sum('observedToolUnionMs'), observedHeaderMs: sum('observedHeaderMs'), observedBodyMs: sum('observedBodyMs'),
    sourceObserverMs: sum('sourceObserverMs'), unfinishedRequests: sum('unfinishedRequests'), abnormalEnds: sum('abnormalEnds')});
}
await atomicJson(join(study, 'time-audit.json'), {executionFinished, rows, groups,
  boundary: 'Passive HTTP stream/header and tool-event interval unions. Incomplete spans remain incomplete; observed time is not a complete aggregate. Observer overhead is reported, not silently subtracted. Queue, generation, model reasoning, provider caching and network causality are not separately identified.'});
console.log(JSON.stringify(groups, null, 2));
