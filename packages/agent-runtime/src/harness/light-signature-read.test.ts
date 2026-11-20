import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightWorkspace } from "./test-client/light-workspace.js";
async function fixture(source: string, path: string, run: (root: string, workspace: LightWorkspace) => Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),"blame-signature-"));try {await writeFile(join(root,path),source);await run(root,new LightWorkspace(root,{sessionId:"signature"}));}finally{await rm(root,{recursive:true,force:true});}
}
for(const [path,source,target] of [
 ["value.ts","export function value(input: number): number {\n  const hidden = 42;\n  return input + hidden;\n}\n","value"],
 ["value.py","def value(input: int) -> int:\n    hidden = 42\n    return input + hidden\n","value"],
] as const)test(`${path}: a signature read omits the implementation and cannot authorize body replacement`,async()=>{
 await fixture(source,path,async(root,workspace)=>{
  const result=await workspace.readCode({target:`${path}#${target}`,view:"signature"},{});
  assert.equal(result.status,"ok",JSON.stringify(result));const data=(result as {data:{signature:string;bodyOmitted:boolean;alias:string;view:string}}).data;
  assert.equal(data.view,"signature");assert.equal(data.bodyOmitted,true);assert.doesNotMatch(data.signature,/hidden|return/u);
  const input={operations:[{kind:"symbol" as const,target:data.alias,action:"replace_body" as const,content:path.endsWith(".py")?"return 2":"return 2;"}]};
  assert.equal((await workspace.editCode(input)).status,"blocked");assert.equal(await readFile(join(root,path),"utf8"),source);
  const body=await workspace.readCode({target:data.alias,view:"symbol"},{});assert.match(JSON.stringify(body),/hidden/u);
  assert.equal((await workspace.editCode(input)).status,"ok");
 });
});
test("a file requires explicit declaration selection instead of silently returning unrelated bytes",async()=>{
 await fixture("function value() { return 1; }\n","value.ts",async(_root,workspace)=>{
  const result=await workspace.readCode({target:"value.ts",view:"signature"},{});assert.equal(result.status,"blocked");assert.match(JSON.stringify(result),/outline/u);
 });
});
test("a subsequent signature cannot refresh observation of an externally changed body",async()=>{
 await fixture("function value() { return 1; }\n","value.ts",async(root,workspace)=>{
  await workspace.readCode({target:"value.ts#value"},{});await writeFile(join(root,"value.ts"),"function value() { return 99; }\n");
  const result=await workspace.readCode({target:"value.ts#value",view:"signature"},{});assert.equal(result.status,"ok");
  assert.equal((await workspace.editCode({operations:[{kind:"symbol",target:"value.ts#value",action:"replace_body",content:"return 2;"}]})).status,"blocked");
 });
});
test("long Unicode signatures stop on a UTF-8 boundary and leave the full declaration available",async()=>{
 const names=Array.from({length:450},(_,i)=>`é${i}: number`).join(", ");
 await fixture(`function value(${names}) { return 1; }\n`,"value.ts",async(_root,workspace)=>{
  const result=await workspace.readCode({target:"value.ts#value",view:"signature"},{});assert.equal(result.status,"ok");
  const data=(result as {data:{signature:string;truncated:boolean}}).data;assert.equal(data.truncated,true);assert.ok(Buffer.byteLength(data.signature)<=4096);assert.doesNotMatch(data.signature,/\uFFFD/u);
  assert.match(JSON.stringify(await workspace.readCode({target:"value.ts#value"},{})),/return 1/u);
 });
});
test("an interface header leaves type members unread until a symbol read",async()=>{
 await fixture("export interface Value { needed: number; }\n","value.ts",async(_root,workspace)=>{
  const header=await workspace.readCode({target:"value.ts#Value",view:"signature"},{});assert.equal(header.status,"ok");assert.doesNotMatch(JSON.stringify(header),/needed/u);
  assert.equal((await workspace.editCode({operations:[{kind:"symbol",target:"value.ts#Value",action:"replace",content:"interface Value { needed: string; }"}]})).status,"blocked");
  assert.match(JSON.stringify(await workspace.readCode({target:"value.ts#Value"},{})),/needed/u);
 });
});
