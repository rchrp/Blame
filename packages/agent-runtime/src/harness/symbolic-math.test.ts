import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSymbolicSource } from "./symbolic-analysis.js";
import { compileSymbolicProgram } from "./symbolic-program.js";
import { symbolicReadHints } from "./light-symbolic-hint.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LightWorkspace } from "./light-workspace.js";

const source = "export function clamp(x:number,y:number):number { return Math.max(0, Math.min(Math.abs(x), y)); }";
const request = { source, functionName: "clamp", inputs: { x: {min:-4,max:4}, y: {min:-4,max:4} }, assertion: "result >= 0" };
test("Math translation agrees with actual JS on an exhaustive integer grid", () => {
  const program = compileSymbolicProgram(request);
  assert.equal(program.assumptions.length, 1);
  for (let x=-4;x<=4;x++) for(let y=-4;y<=4;y++)
    assert.deepEqual(program.reproduce({x,y}), {result:Math.max(0,Math.min(Math.abs(x),y)),assertion:true});
});
for (const [name, body] of Object.entries({ empty:"Math.max()", spread:"Math.max(...[x])", wrongAbs:"Math.abs(x,x)",
  float:"Math.floor(x)", computed:"Math['min'](x,1)", optional:"Math?.max(x,1)", coercion:"Math.max(x,true)" }))
  test(`unsupported Math form remains refused: ${name}`, () => {
    assert.throws(() => compileSymbolicProgram({...request,source:`function clamp(x:number,y:number){return ${body};}`}));
  });
for (const prefix of ["const Math = {max:()=>0};", "import Math from './custom.ts';", "Math.max = ()=>0;",
  "globalThis.Math.max = ()=>0;", "Object.assign(Math, {max:()=>0});", "Math.max++;", "const \\u004dath = {};" ])
  test(`visible rebinding or mutation is refused: ${prefix}`, () => {
    assert.throws(() => compileSymbolicProgram({...request,source:prefix+source}));
  });
test("actual solver uses standard Math assumptions and still finds violating inputs", {skip:!process.env.BLAME_Z3_PATH}, async () => {
  const result = await analyzeSymbolicSource({...request, assertion:"result === x", solverPath:process.env.BLAME_Z3_PATH});
  assert.equal(result.status,"counterexample"); assert.equal(result.validationAdmission,false);
  assert.equal(result.assumptions?.length,1);
  const {x,y}=result.witness!.inputs as {x:number;y:number};
  assert.equal(result.witness!.result,Math.max(0,Math.min(Math.abs(x),y)));
  assert.notEqual(result.witness!.result,x);
});
test("shape hints expose no inferred property or bounds and refuse unsupported callees", () => {
  const hints=symbolicReadHints("clamp.ts",source);
  assert.equal(hints.length,1);assert.deepEqual(hints[0]?.parameters,["x","y"]);
  assert.equal('inputs' in hints[0]!,false); assert.equal('assertion' in hints[0]!,false);
  assert.deepEqual(symbolicReadHints("clamp.ts",source.replace("Math.max","custom")),[]);
  assert.deepEqual(symbolicReadHints("clamp.js",source),[]);
});
test("analysis discovery requires opt-in and an emitted body; signature reads grant no body coverage", async () => {
  const root=await mkdtemp(join(tmpdir(),"blame-hints-"));
  const previous=process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS, oldHints=process.env.BLAME_AGENT_SYMBOLIC_HINTS;
  try {
    await writeFile(join(root,"clamp.ts"),source);
    process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS="false";
    const off=new LightWorkspace(root,{sessionId:"off"});
    assert.doesNotMatch(JSON.stringify(await off.readCode({target:"clamp.ts"},{})),/symbolicAnalysis/);
    process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS="true";
    process.env.BLAME_AGENT_SYMBOLIC_HINTS="true";
    const on=new LightWorkspace(root,{sessionId:"on"});
    assert.doesNotMatch(JSON.stringify(await on.readCode({target:"clamp.ts#clamp",view:"signature"},{})),/symbolicAnalysis/);
    const result=await on.readCode({target:"clamp.ts#clamp",view:"symbol"},{});
    assert.match(JSON.stringify(result),/symbolicAnalysis/);
    assert.doesNotMatch(JSON.stringify(await on.readCode({target:"@checks"},{})),/vitest_report/);
    process.env.BLAME_AGENT_SYMBOLIC_HINTS="false";
    assert.doesNotMatch(JSON.stringify(await new LightWorkspace(root,{sessionId:"nohint"}).readCode({target:"clamp.ts"},{})),/symbolicAnalysis/);
  } finally {
    if(previous===undefined)delete process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS;else process.env.BLAME_AGENT_SYMBOLIC_ANALYSIS=previous;
    if(oldHints===undefined)delete process.env.BLAME_AGENT_SYMBOLIC_HINTS;else process.env.BLAME_AGENT_SYMBOLIC_HINTS=oldHints;
    await rm(root,{recursive:true,force:true});
  }
});

test("intrinsics used only in the supplied property also record assumptions", () => {
  const program=compileSymbolicProgram({...request,source:"function clamp(x:number,y:number){return x;}",assertion:"result <= Math.max(x,y)"});
  assert.equal(program.assumptions.length,1);
});
