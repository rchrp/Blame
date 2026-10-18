// Passive research preload. Both arms receive identical code; requests are never rewritten.
import {appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {bodyReceiptMetadata} from './feedback-wire-metadata.mjs';
import {provenanceMetadata} from './provenance-observations.mjs';
const destination=process.env.BLAME_STUDY_FEEDBACK_WIRE_AUDIT;if(!destination)throw Error('Explicit feedback audit destination required');
const original=globalThis.fetch,sha=s=>createHash('sha256').update(s).digest('hex');
globalThis.fetch=async function feedbackAuditedFetch(input,init){
 const raw=typeof init?.body==='string'?init.body:input instanceof Request&&input.method==='POST'?await input.clone().text():undefined;
 let body;try{if(raw)body=JSON.parse(raw);}catch{}
 if(body&&typeof body.model==='string'&&(body.input||body.messages))await appendFile(destination,JSON.stringify({time:new Date().toISOString(),requestBodySha256:sha(raw),bodyReceipts:bodyReceiptMetadata(body),...(process.env.BLAME_STUDY_PROVENANCE_AUDIT==='true'?{validationStates:provenanceMetadata(body)}:{})})+'\n');
 return original(input,init);
};
