// Reproducibility artifacts only; run after live workers have exited.
import assert from 'node:assert/strict';
import {readFile, mkdir, readdir, cp} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {evidence} from './evidence.mjs';
import {tasks, work, study, repo} from './inputs.mjs';
import {atomicJson, atomicWrite, digest} from '../durable-campaign.mjs';
const {protocol: p, executionFinished} = await evidence();
assert.equal(executionFinished, true);
const destination = join(study, 'inputs'); await mkdir(destination, {recursive: true});
const bare = join(work, 'original-inputs.git');
execFileSync('git', ['init', '--bare', '--quiet', bare]);
const refs = {};
for (const task of tasks) {
  const root = join(work, 'inputs', task.id);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(head, p.inputs[task.id].head);
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim(), '');
  execFileSync('git', ['fetch', '--quiet', root, 'HEAD:refs/heads/' + task.id], {cwd: bare}); refs[task.id] = head;
}
const bundle = join(work, 'original-inputs.bundle');
execFileSync('git', ['bundle', 'create', bundle, '--branches'], {cwd: bare});
await atomicWrite(join(destination, 'original-inputs.bundle'), await readFile(bundle), {exclusive: true});
const frozen = join(work, 'frozen/model'), actual = {};
for (const e of await readdir(frozen, {recursive: true, withFileTypes: true})) if (e.isFile())
  actual[relative(frozen, join(e.parentPath, e.name))] = digest(await readFile(join(e.parentPath, e.name)));
assert.deepEqual(actual, p.runtimeFiles);
const runtime = join(destination, 'frozen-model-runtime.tar.gz');
execFileSync('tar', ['-czf', runtime, '--exclude=node_modules', '-C', frozen, '.']);
const lock = execFileSync('git', ['show', p.sourceHead + ':pnpm-lock.yaml'], {cwd: repo});
assert.equal(digest(lock), p.lockSha256); await atomicWrite(join(destination, 'runtime-pnpm-lock.yaml'), lock, {exclusive: true});
const dependencies = join(repo, '.blame/research/validation-recovery-f63/dependencies');
for (const name of ['package.json', 'package-lock.json']) await cp(join(dependencies, name), join(destination, 'dependencies-' + name));
assert.equal(digest(await readFile(join(destination, 'dependencies-package-lock.json'))), p.dependencyLockSha256);
const originalCoordinator = execFileSync('git', ['show', p.sourceHead + ':tools/terminal_bench/feedback-delivery-study/campaign.mjs'], {cwd: repo});
assert.equal(digest(originalCoordinator), p.boundScripts['campaign.mjs']);
await atomicWrite(join(destination, 'original-coordinator.mjs.txt'), originalCoordinator, {exclusive: true});
await atomicJson(join(destination, 'manifest.json'), {bundleSha256: digest(await readFile(bundle)), refs,
  runtimeSha256: digest(await readFile(runtime)), runtimeLockSha256: digest(lock),
  dependencyLockSha256: p.dependencyLockSha256, runtimeSourceHead: p.sourceHead,
  boundary: 'Original input commits only, shared Git objects; no model patches, researcher solutions, dependencies, credentials or fetched solution history. Git commit identities replace platform-dependent tar metadata for portable replay; the original private archive hashes remain unchanged.'}, {exclusive: true});
console.log('Archived original source commits, exact compiled runtime, and pinned locks.');
