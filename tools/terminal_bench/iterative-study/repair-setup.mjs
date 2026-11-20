// Administrative packaging repair. Preserve the initial campaign, including
// its initialization failures and the completed native model attempt.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { score, analyse, fileTree } from './run.mjs';
import { reserveTrialCosts } from '../navigation-evidence/budget-accounting.mjs';
import { repo, study, work, json, save, sha } from './setup.mjs';
const initial = join(work, 'campaign-initial');
const rows = (await json(join(initial, 'analysis.json'))).rows;
const directory = join(initial, '1-form-length-declarations');
const result = await json(join(directory, 'result.json'));
assert.equal(result.status, 'failed'); assert.match(result.error, /prompt\/code-agent-system\.txt/u);
const grade = await score(directory, 'form-length'); await save(join(directory, 'score.json'), grade);
const exit = { code: null, signal: null, watchdog: false, durationMs: null,
  reason: 'Worker result durable and child observed zombie; paused scheduler stopped before persisting its exit event. Exit code/duration are not invented.' };
const { row } = await analyse({ repeat: 1, task: 'form-length', arm: 'declarations' }, directory, exit, grade);
rows.push(row);
const wireByTrial = {};
for (const r of rows) {
  const bytes = await readFile(join(initial, r.name, 'wire-contracts.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  wireByTrial[r.name] = bytes.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const protocol = await json(join(study, 'initial-protocol.json'));
const accounting = reserveTrialCosts(rows, wireByTrial, protocol.budgets);
await save(join(initial, 'analysis-at-stop.json'), { planned: 12, started: 4, unstarted: 8, rows });
await save(join(study, 'initial-accounting.json'), accounting);
const prior = await json(join(study, 'initial-prior-budget.json'));
await save(join(study, 'prior-budget.json'), { parent: 'initial-accounting.json',
  parentSha256: sha(await readFile(join(study, 'initial-accounting.json'))), earlier: prior,
  observedUsd: prior.observedUsd + accounting.observedUsd,
  reservedUsd: prior.reservedUsd + accounting.reservedUsd,
  accountedUsd: prior.accountedUsd + accounting.accountedUsd });

const smoke = [];
for (const arm of ['reference', 'declarations']) {
  const root = join(work, 'frozen', arm, 'agent-runtime/dist');
  const source = join(repo, 'packages/agent-runtime/src');
  await cp(join(source, 'prompt'), join(root, 'prompt'), { recursive: true });
  await mkdir(join(root, 'plugins/blame-native'), { recursive: true });
  await cp(join(source, 'plugins/blame-native/skills'), join(root, 'plugins/blame-native/skills'), { recursive: true });
  const mod = await import(pathToFileURL(join(root, 'cline-runtime-prompts.js')).href);
  const text = await mod.buildDevelopmentSystemPrompt({ cwd: join(work, 'declaration-preflight'), workspaceRoot: join(work, 'declaration-preflight') });
  assert.ok(text.length > 1000); assert.ok(!text.includes('{{WORKSPACE_ROOT}}'));
  smoke.push({ arm, promptBytes: Buffer.byteLength(text), promptRenderedSha256: sha(text), assetFiles: await fileTree(join(root, 'prompt')) });
}
assert.deepEqual(smoke[0].assetFiles, smoke[1].assetFiles);
await save(join(study, 'asset-smoke.json'), { modelRequests: 0, rows: smoke,
  repair: 'Only common non-JavaScript build assets omitted by the JS-only F37 archive. Source prompt/plugin assets unchanged from 8ceb9139. No model source was repaired.' });
protocol.phase = 'F38b'; protocol.registeredAtUTC = new Date().toISOString();
protocol.administrativeCorrection = { initial: 'initial-protocol.json', record: 'administrative-stop-initial.json',
  unchanged: ['tasks', 'instructions', 'oracles', 'order', 'model', 'effort', 'budgets'],
  changed: 'Common prompt/plugin non-JS assets restored; scheduler can pause before starting another trial.',
  interpretation: 'Corrected separate campaign on the same prospectively selected tasks. One native clear-count attempt was observed in the initial campaign; not wholly fresh confirmation. Do not pool original failures with corrected outcomes or erase them.' };
await save(join(study, 'protocol.json'), protocol);
await save(join(study, 'budget-preflight.json'), { paidRequests: 0, priorAccountedUsd: prior.accountedUsd + accounting.accountedUsd,
  nextReservationUsd: 0.33, admitted: prior.accountedUsd + accounting.accountedUsd + 0.33 <= protocol.budgets.sharedStudyObservedCostStopUsd,
  scheduling: 'Re-evaluate the fixed panel/shared ceilings before each assignment; retain any unstarted tail if reserved accounting reaches the ceiling.' });
console.log(JSON.stringify({ initialStarted: rows.length, accounting, smoke: smoke.map(r => ({ arm: r.arm, promptBytes: r.promptBytes })) }));
