import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSymbolicSource } from "./symbolic-analysis.js";
import { compileSymbolicProgram } from "./symbolic-program.js";
import { symbolicReadHints } from "./light-symbolic-hint.js";

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
