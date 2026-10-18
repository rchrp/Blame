// Evidence extraction only. Acceptance requires explicit source/delivery review.
import {readFile} from 'node:fs/promises';import {readJsonLines} from './evidence-io.mjs';import {join,resolve} from 'node:path';import {work as defaultWork,study as defaultStudy,json,save} from './setup.mjs';
const work=defaultWork,study=defaultStudy;
const protocol=await json(join(study,'protocol.json'));
const checkNames=protocol.tasks[0].requiredChecks.map(c=>c.id);
const commandFor=name=>'npm run '+protocol.tasks[0].requiredChecks.find(c=>c.id===name).task;
const requiredCommands=new Set(checkNames.map(commandFor));
const analysis=await json(join(work,'campaign/analysis.json'));const packets=[];
for(const row of analysis.rows){
 const dir=join(work,'campaign',row.name),tools=await json(join(dir,'tool-ledger.json'));
 const lastEdit=tools.findLastIndex(t=>t.tool==='edit_code'&&t.output?.status==='ok'&&t.output?.data?.changed!==false||t.tool==='apply_patch'&&t.output?.success===true);
 const commands=[];
 for(const [index,t]of tools.entries()){
  if(t.tool==='run_task'&&t.output?.data?.command)commands.push({index,input:t.input,command:t.output.data.command.replace(/ -- --listFiles --pretty false$/u,''),exitCode:t.output.data.exitCode??null,processSuccess:t.output.data.exitCode===0,check:t.output.data.check??null});
  else if(t.tool==='run_task'&&t.output?.status==='blocked')commands.push({index,input:t.input,command:t.input?.command??`[project task ${t.input?.task??'unknown'}]`,exitCode:null,processSuccess:false,reportedExitCode:t.output.message?.match(/^Command exited with code (\d+)\./)?.[1]??null,output:t.output.message});
  if(t.tool==='run_commands')for(const o of Array.isArray(t.output)?t.output:[])commands.push({index,input:t.input,command:o.query,exitCode:null,processSuccess:o.success===true,output:o.output??o.result??o});
 }
 const required=Object.fromEntries(checkNames.map(name=>[name,commands.filter(c=>(c.command===commandFor(name) || c.command.split(' && ').every(s=>requiredCommands.has(s)) && c.command.split(' && ').includes(commandFor(name)))&&c.index>lastEdit&&c.processSuccess)]));
 const shellWriteCandidates=commands.filter(c=>/writeFile|write_text|write_bytes|writeSync|--write|\btee\b|\bsed\s+-i|\bperl\s+-i|\bgit\s+(?:apply|checkout|restore)|\bcat\s*>/.test(JSON.stringify(c.input)));
 const events=(await readJsonLines(join(dir,'events.jsonl'))).rows.map(row=>row.event).filter(Boolean);
 const delivery=events.findLast(e=>e.type==='done')?.payload?.text??tools.findLast(t=>t.tool==='finish_task')?.input?.summary??null;
 const blocked=tools.filter(t=>t.output?.status==='blocked').map(t=>({tool:t.tool,input:t.input,output:t.output}));
 const scopeCommands=commands.filter(c=>/curl|wget|git\s+(?:show|log|fetch|clone)|\.\.\/|\/workspace\/Blame(?!\/\.blame\/research\/confirmation-f42\/campaign\/)/.test(c.command));
 packets.push({name:row.name,hashes:row.hashes,official:row.officialRuntimeSuccess,functional:row.independentFunctionalSuccess,lastEdit,required,commands,shellWriteCandidates,delivery,blocked,scopeCommands,completion:row.completion,selectionFailures:row.selectionFailures,noTestFileOutputs:row.noTestFileOutputs,finishFailures:row.finishFailures,evidenceAnomalies:row.evidenceAnomalies,finishObservations:row.finishObservations,symbolicObservations:row.symbolicObservations,directSolverCommands:row.directSolverCommands,schemas:row.schemas});
}
await save(join(study,'audit-packets.json'),{complete:analysis.rows.length===protocol.order.length,method:'lastEdit identifies successful explicit editing tools, excluding unchanged edits. Shell-write candidates are a conservative review aid, not a complete parser or proof of no mutation. Manual finalSourceChecksPassed review must also inspect commands and delivery; independent endpoint checks run on the archived final source.',packets});
console.log(JSON.stringify(packets.map(p=>({name:p.name,official:p.official,functional:p.functional,required:Object.fromEntries(Object.entries(p.required).map(([k,v])=>[k,v.length])),blocked:p.blocked.length}))));

await save(join(study,'source-review.template.json'),{method:'Unblinded manual review of immutable patch, delivery and command chronology; all booleans require evidence. Inspect public function signatures manually: structural type assignments do not exclude any or enforce exact parameter arity/order. Symbolic results are bounded to their supplied property/domain; unsupported syntax and absent usage are valid negatives, and no-counterexample claims must not be reported as project verification. Copy to source-review.json and fill, never infer task success from official completion alone.',decisions:await Promise.all(analysis.rows.map(async row=>{const grade=await json(join(work,'campaign',row.name,'score.json'));return {name:row.name,hashes:row.hashes,sourceBehaviorPassed:null,addedTestsPassed:grade.addedTests.length>0&&grade.deliveredChecks.every(c=>c.exitCode===0),finalSourceChecksPassed:null,noSolutionRetrieval:null,fullRequestPassed:null,symbolicClaimsAccurate:null,dependencyIntegrityPassed:grade.dependencyIntegrity?.pinnedDependenciesUnchanged??null,symbolicEvidence:row.symbolicObservations.map(item=>({toolIndex:item.index,propertyRelevant:null,witnessExercisedInRealTest:null,evidence:[]})),evidence:[]};}))});
