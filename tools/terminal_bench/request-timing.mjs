// Research-only demand-driven observation. No request/response content is saved.
import {createHash} from 'node:crypto';

export function createTimedFetch(fetch, {record, now = () => performance.now(), timeOrigin = performance.timeOrigin}) {
  let sequence = 0;
  return async function timedFetch(input, init) {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    let body; try { if (raw) body = JSON.parse(raw); } catch {}
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const modelRequest = body && typeof body.model === 'string' && (body.input || body.messages);
    const uninspectable = !raw && input instanceof Request && input.method === 'POST' && /\/(?:responses|chat\/completions)$/.test(url.pathname);
    if (!modelRequest && !uninspectable) return fetch(input, init);
    const attempt = ++sequence;
    const identity = {attempt, requestBodySha256: raw ? createHash('sha256').update(raw).digest('hex') : null,
      requestBytes: raw ? Buffer.byteLength(raw) : null};
    const emit = (event, fields = {}) => record({...identity, event, monotonicMs: now(), timeOriginMs: timeOrigin, ...fields});
    emit('fetch_started', {inspectable: !uninspectable});
    let response;
    try { response = await fetch(input, init); }
    catch (error) { try { emit('fetch_error', {aborted: (init?.signal ?? (input instanceof Request ? input.signal : undefined))?.aborted === true}); } finally { throw error; } }
    emit('response_headers', {status: response.status, hasBody: response.body !== null});
    if (!response.body) { emit('body_absent'); return response; }
    if (response.status < 200 || response.status > 599) { emit('body_unobserved'); return response; }
    let reader, first = true, finished = false, bytes = 0;
    const finish = event => { if (!finished) { finished = true; emit(event, {readBytes: bytes}); } };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          reader ??= response.body.getReader();
          const next = await reader.read();
          if (next.done) { finish('body_end'); reader.releaseLock(); controller.close(); return; }
          bytes += next.value.byteLength;
          if (first && next.value.byteLength) { first = false; emit('first_body_read'); }
          controller.enqueue(next.value);
        } catch (error) { try { finish('body_error'); } finally { reader?.releaseLock(); controller.error(error); } }
      },
      async cancel(reason) {
        try { finish('body_cancelled'); } finally {
          if (reader) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
          else await response.body.cancel(reason);
        }
      },
    }, {highWaterMark: 0});
    return preserveMetadata(new Response(stream, {status: response.status, statusText: response.statusText, headers: response.headers}), response);
  };
}

function preserveMetadata(value, original) {
  for (const key of ['url', 'redirected', 'type']) Object.defineProperty(value, key, {value: original[key]});
  const clone = value.clone.bind(value);
  Object.defineProperty(value, 'clone', {value: () => preserveMetadata(clone(), original)});
  return value;
}

/** Interval unions prevent parallel tool/stream work being counted twice. */
export function mergeIntervals(intervals) {
  const kept = intervals.filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).map(x => [...x]).sort((a,b) => a[0]-b[0]);
  const result = [];
  for (const [a,b] of kept) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1],b); else result.push([a,b]);
  }
  return result;
}
export const intervalMs = intervals => mergeIntervals(intervals).reduce((n,[a,b]) => n+b-a,0);
export function intersectionMs(left, right) {
  let total = 0;
  for (const [a,b] of mergeIntervals(left)) for (const [c,d] of mergeIntervals(right)) total += Math.max(0,Math.min(b,d)-Math.max(a,c));
  return total;
}
