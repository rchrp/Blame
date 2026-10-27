// Unchanged model-patch replay after all external workers have exited.
import assert from 'node:assert/strict';
import {readFile, mkdir, mkdtemp, symlink, cp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {tasks, study, work, repo} from './inputs.mjs';
import {endpoint} from './controls.mjs';
import {restoreInput} from './restore-input.mjs';
import {evidence} from './evidence.mjs';
import {sourceEpoch} from './source-epoch.mjs';
import {atomicJson, digest, trialName} from '../durable-campaign.mjs';
const {protocol: p, records, executionFinished, modelCompleted} = await evidence();
assert.equal(executionFinished, true, 'Wait until every original assignment is completed or explicitly interrupted');
const completedRecords = records.filter(c => !c.partial);
const modules = join(repo, '.blame/research/validation-recovery-f63/dependencies/node_modules');
const destination = join(work, 'replays'); await mkdir(destination, {recursive: true});
const results = [];
for (const checkpoint of completedRecords) {
  const slot = checkpoint.row, name = checkpoint.name, task = tasks.find(t => t.id === slot.task);
  const file = path => {
    const record = checkpoint.files[path], bytes = Buffer.from(record.base64, 'base64');
    assert.equal(digest(bytes), record.sha256); return bytes;
  };
  const options = {portable: process.argv.includes('--portable')};
  const original = await mkdtemp(join(destination, name + '-'));
  await restoreInput(original, task.id, p, options);
  const patch = file('workspace.diff');
  if (patch.length) execFileSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {cwd: original, input: patch});
  const expectedEpoch = JSON.parse(file('source-at-exit.json'));
  assert.equal(sourceEpoch(original).sha256, expectedEpoch.sha256, name + ': reconstructed patch differs from delivered source');
  const audit = await mkdtemp(join(destination, name + '-immutable-'));
  await restoreInput(audit, task.id, p, options); await symlink(modules, join(audit, 'node_modules'));
  // Repeat the frozen grader: only permitted source edits enter immutable checks.
  const row = checkpoint.row;
  const allowed = row.score.changedPaths.filter(path => !row.score.protectedPaths.includes(path));
  for (const path of allowed) {
    await mkdir(join(audit, path, '..'), {recursive: true});
    try {await cp(join(original, path), join(audit, path));}
    catch (e) {if (e.code !== 'ENOENT') throw e; await rm(join(audit, path), {force: true});}
  }
  const endpoints = row.score.endpoints.map(expected => {
    const actual = endpoint(audit, expected.name, task.id);
    assert.equal(actual.exitCode, expected.exitCode, name + ': ' + expected.name);
    assert.equal(actual.signal, expected.signal, name + ': ' + expected.name + ' signal');
    return {name: actual.name, exitCode: actual.exitCode, signal: actual.signal, error: actual.error, durationMs: actual.durationMs};
  });
  results.push({name, patchSha256: digest(patch), exactSourceReconstructed: true, endpoints});
  await atomicJson(join(study, options.portable ? 'portable-patch-replays.json' : 'patch-replays.json'), {complete: results.length === modelCompleted, planned: modelCompleted, originalAssignments: p.order.length, interruptedNotRetried: records.filter(c => c.partial).map(c => c.name), results,
    boundary: 'No model calls, no solution recovery or patch repair; original immutable checks and original five frozen endpoint criteria.'});
  console.log('REPLAY', name, endpoints.map(e => e.exitCode).join(','));
}
