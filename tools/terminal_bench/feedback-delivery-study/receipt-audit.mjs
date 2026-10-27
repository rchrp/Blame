import {appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {feedbackReceipts} from './receipt-metadata.mjs';
const destination=process.env.BLAME_STUDY_RECEIPT_AUDIT,original=globalThis.fetch;
if(!destination)throw Error('Explicit receipt metadata destination required');
globalThis.fetch=async(input,init)=>{
 const raw=typeof init?.body==='string'?init.body:input instanceof Request&&input.method==='POST'?await input.clone().text():undefined;
 let body;try{body=JSON.parse(raw);}catch{}
 if(body?.model&&(body.input||body.messages))await appendFile(destination,JSON.stringify({time:new Date().toISOString(),requestBodySha256:createHash('sha256').update(raw).digest('hex'),receipts:feedbackReceipts(body)})+'\n');
 return original(input,init);
};
