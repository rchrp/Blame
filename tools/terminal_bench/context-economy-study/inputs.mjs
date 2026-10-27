import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, cp, symlink, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {atomicJson, digest} from '../durable-campaign.mjs';
export const repo = resolve(import.meta.dirname, '../../..');
export const work = '/workspace/blame-study-runs/context-f68';
export const study = join(repo, 'docs/experiments/light-harness-context-economy-f68-2026-10-27');
export const registration = JSON.parse(await readFile(join(study, 'selection-registration.json')));
export const tasks = registration.panels.flatMap(p => p.tasks.map(t => ({...t, panel: p.id})));
const upstream = join(work, 'query-upstream');
export const baselineModules = task => task.panel === 'F68'
  ? join(repo, '.blame/research/validation-recovery-f63/dependencies/node_modules')
  : join(repo, '.blame/research/context-f68', task.id === 'mutation-callbacks' ? 'dependencies-v4' : 'dependencies', 'node_modules');
export const checksFor = task => task.panel === 'F68'
  ? ['regression','types','delivered'].map(id => ({id, task: 'test:study:' + id})).concat({id:'delivered-types',task:'typecheck:delivered'})
  : ['regression','types',task.id === 'fetching-filters' ? 'type-regression' : 'delivered','delivered-types'].map(id => ({id, task:(id === 'regression' || id === 'delivered' ? 'test:study:' : 'typecheck:study:') + id}));
export function instruction(task) {
  return task.request + (task.panel === 'F68' ? ' First reproduce the existing diagnostic by running exactly node node_modules/typescript/bin/tsc --noEmit -p tsconfig.check.json.' : '') +
    ' Work only in this supplied checkout. Do not retrieve remote history, patches, solutions or study artifacts, install dependencies, alter manifests/configuration, or weaken supplied tests. Preserve public APIs except the requested change. After the final source/test edit, run every required command directly as its own invocation: ' +
    checksFor(task).map(c => 'npm run ' + c.task).join('; ') + '. Avoid shell loops, masking and wrappers so each outcome remains observable. Report exact outcomes and coverage limits. Execution, passing, admitted verification and satisfaction of user criteria are distinct.';
}
const git = (root, args, extra = {}) => execFileSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:32*1024*1024, ...extra});
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
export async function prepareInputs() {
  await access(join(work, 'input-manifest.json')).then(() => {throw Error('Refuse replacing frozen inputs');}, e => {if (e.code !== 'ENOENT') throw e;});
  await mkdir(join(work, 'inputs'), {recursive:true}); await mkdir(join(work, 'official'), {recursive:true});
  const manifest = {};
  for (const task of tasks) {
    const root = join(work, 'inputs', task.id); await mkdir(root, {recursive:true});
    if (task.panel === 'F68') {
      execFileSync('tar', ['-xzf', `/workspace/blame-study-runs/feedback-f65/inputs/${task.id}.tar.gz`, '-C', root]);
    } else {
      const source = execFileSync('git', ['archive', task.base], {cwd:upstream,maxBuffer:40*1024*1024});
      execFileSync('tar', ['-xf','-','-C',root], {input:source}); await mkdir(join(root,'.study'));
      const originalTests = git(upstream, ['ls-tree','-r','--name-only',task.base]).trim().split('\n').filter(p=>p.includes('/__tests__/'));
      const selected = task.id === 'fetching-filters' ? ['packages/query-core/src/__tests__/queryClient.test-d.tsx','packages/react-query/src/__tests__/useIsFetching.test-d.tsx'] : ['packages/query-core/src/__tests__/mutationObserver.test.tsx'];
      const official = git(upstream, ['diff',task.base,task.fix,'--',...selected]);
      assert.ok(official.includes('diff --git')); await writeFile(join(work,'official',task.id+'.patch'),official);
      // A production-only positive control, never copied into a worker input.
      const production = execFileSync('git',['diff',task.base,task.fix,'--',...task.scope,':(exclude)**/__tests__/**'],{cwd:upstream,encoding:'utf8'});
      await writeFile(join(work,'official',task.id+'-positive.patch'),production);
      await save(join(root,'.study/task.json'),{id:task.id,originalTests,scope:task.scope});
      const pkg = JSON.parse(await readFile(join(root,'package.json')));
      pkg.packageManager='npm@12.2.1';
      pkg.scripts={...pkg.scripts,'test:study:regression':'node .study/checks.mjs regression','typecheck:study:types':'node node_modules/typescript/bin/tsc --noEmit -p .study/source-tsconfig.json','typecheck:study:type-regression':'node node_modules/typescript/bin/tsc --noEmit -p .study/type-tsconfig.json','test:study:delivered':'node .study/checks.mjs delivered','typecheck:study:delivered-types':'node .study/checks.mjs delivered-types'};
      await save(join(root,'package.json'),pkg);
      await cp(join(import.meta.dirname,'project-checks.mjs'),join(root,'.study/checks.mjs'));
      const aliases={ '@tanstack/query-core':['packages/query-core/src/index.ts'], '@tanstack/react-query':['packages/react-query/src/index.ts'], '@tanstack/query-test-utils':['packages/query-test-utils/src/index.ts'] };
      const compilerOptions={target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,jsx:'react-jsx',esModuleInterop:true,allowSyntheticDefaultImports:true,lib:['ES2022','DOM','DOM.Iterable'],types:['node'],customConditions:['@tanstack/custom-condition'],paths:Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,v.map(p=>'../'+p)]))};
      await save(join(root,'.study/source-tsconfig.json'),{compilerOptions,include:[...task.scope.map(p=>'../'+p+'/**/*'), '../packages/query-test-utils/src/**/*'],exclude:['../**/__tests__/**']});
      await save(join(root,'.study/type-tsconfig.json'),{compilerOptions,files:['../packages/query-core/src/__tests__/queryClient.test-d.tsx']});
      const aliasPaths = Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,v[0]]));
      const setup = task.id === 'fetching-filters' ? ["packages/react-query/test-setup.ts"] : [];
      const module = "import {fileURLToPath} from 'node:url';const root=new URL('../',import.meta.url);const aliases="+JSON.stringify(aliasPaths)+";export default {cacheDir:'.study/reports/vite-cache',resolve:{conditions:['@tanstack/custom-condition'],alias:Object.fromEntries(Object.entries(aliases).map(([k,p])=>[k,fileURLToPath(new URL(p,root))]))},test:{setupFiles:"+JSON.stringify(setup)+",environment:'jsdom',restoreMocks:true,watch:false,maxWorkers:1,fileParallelism:false,coverage:{enabled:false},typecheck:{enabled:false}}};\n";
      await writeFile(join(root,'.study/vitest.config.mjs'),module);
      git(root,['init','--quiet']); await writeFile(join(root,'.git/info/exclude'),'.blame/\nnode_modules\n.study/reports/\n');
      git(root,['add','.']); git(root,['add','-f','.study']);
      git(root,['-c','user.name=Study','-c','user.email=study@example.invalid','commit','--quiet','-m','Frozen natural issue input'],{env:{...process.env,GIT_AUTHOR_DATE:'2026-10-27T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-27T00:00:00Z'}});
    }
    assert.equal(git(root,['status','--porcelain']).trim(),'');
    const head=git(root,['rev-parse','HEAD']).trim(),archive=join(work,'inputs',task.id+'.tar.gz');
    execFileSync('tar',['-czf',archive,'--exclude=node_modules','-C',root,'.']);
    manifest[task.id]={head,archiveSha256:digest(await readFile(archive)),instructionSha256:digest(instruction(task)),requiredChecks:checksFor(task),upstreamBase:task.base??null,upstreamFix:task.fix??null};
  }
  await atomicJson(join(work,'input-manifest.json'),manifest,{exclusive:true}); console.log('Four immutable task inputs prepared; no model request.');
}
if(process.argv[1]===import.meta.filename)await prepareInputs();
