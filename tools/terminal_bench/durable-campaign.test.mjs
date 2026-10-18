import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {gzipSync, gunzipSync} from 'node:zlib';
import {DurableCampaign, atomicJson, digest, UncertainTrialError} from './durable-campaign.mjs';

const slot = {repeat: 1, task: 'diagnostic', arm: 'candidate'}, name = '1-diagnostic-candidate';
const protocol = {order: [slot], budgets: {perTrialSdkCostLimitUsd: .5, requestOvershootReserveUsd: .25}};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'durable-study-test-'));
  const options = {campaign: join(root, 'private'), study: join(root, 'public'), protocol, protocolHash: digest('frozen protocol')};
  const stores = [], make = (changes = {}) => {const store = new DurableCampaign({...options, ...changes}); stores.push(store); return store;};
  t.after(async () => {for (const store of stores) await store.release(); await rm(root, {recursive: true, force: true});});
  return {root, options, make, store: make()};
}
async function complete(store) {
  await store.begin(slot);
  const directory = join(store.campaign, name);
  await atomicJson(join(directory, 'model-exit.json'), {code: 0});
  const bytes = Buffer.from('{"status":"succeeded"}\n'); await writeFile(join(directory, 'result.json'), bytes);
  const row = {...slot, name, usage: {input: null, cost: null}, hashes: {'result.json': digest(bytes)}};
  await store.checkpoint(row, [{model: 'pinned-model'}]); return row;
}

test('completed immutable archive restores missing private files and null measurements without another model call', async t => {
  const {store, options, make} = await fixture(t); await store.acquire(); const row = await complete(store); await store.release();
  await rm(options.campaign, {recursive: true}); // Materialized state lost, durable archive survives.
  const recovered = make(); await recovered.acquire(); t.after(() => recovered.release());
  const state = await recovered.restoreCompleted(); assert.deepEqual(state.rows, [row]);
  assert.equal(state.rows[0].usage.cost, null); assert.equal((await recovered.inspect(slot)).state, 'complete');
  assert.deepEqual(JSON.parse(await readFile(join(options.campaign, name, 'result.json'))), {status: 'succeeded'});
  assert.equal((await recovered.restoreCompleted()).rows.length, 1);
});
test('a start without an exit blocks replay and retains unknown consumption plus a distinct reserve', async t => {
  const {store, options} = await fixture(t); await store.acquire(); t.after(() => store.release()); await store.begin(slot);
  await assert.rejects(store.inspect(slot), UncertainTrialError);
  const record = JSON.parse(await readFile(join(options.study, 'interrupted-trial.json')));
  assert.equal(record.sdkObservedUsd, null); assert.equal(record.schedulingReserveUsd, .75); assert.equal(record.modelRetried, false);
  await assert.rejects(store.begin(slot), {code: 'EEXIST'});
});
test('recorded model exit routes to offline finalization, never another invocation', async t => {
  const {store} = await fixture(t); await store.acquire(); t.after(() => store.release()); await store.begin(slot);
  await atomicJson(join(store.campaign, name, 'model-exit.json'), {code: 0});
  assert.equal((await store.inspect(slot)).state, 'finalize'); await assert.rejects(store.begin(slot), {code: 'EEXIST'});
});
test('a crash between recorded exit and grading resumes the workflow with exactly one model invocation', async t => {
  const {store, make} = await fixture(t); let invocations = 0, grades = 0;
  await store.acquire(); await store.begin(slot); invocations++;
  await atomicJson(join(store.campaign, name, 'model-exit.json'), {code: 0}); await store.release();
  const resumed = make(); await resumed.acquire(); t.after(() => resumed.release());
  assert.equal((await resumed.inspect(slot)).state, 'finalize'); grades++;
  await resumed.checkpoint({...slot, name, hashes: {}, usage: {cost: null}}, []);
  assert.equal((await resumed.inspect(slot)).state, 'complete');
  assert.equal((await resumed.restoreCompleted()).rows.length, 1);
  assert.equal(invocations, 1); assert.equal(grades, 1);
});
test('corrupted archived source evidence is rejected', async t => {
  const {store} = await fixture(t); await store.acquire(); t.after(() => store.release()); await complete(store);
  const path = join(store.checkpoints, name + '.json.gz'), value = JSON.parse(gunzipSync(await readFile(path)));
  value.files['result.json'].base64 = Buffer.from('different').toString('base64'); await writeFile(path, gzipSync(JSON.stringify(value)));
  await assert.rejects(store.restoreCompleted());
});
test('a checkpoint cannot be imported under another protocol', async t => {
  const {store, options, make} = await fixture(t); await store.acquire(); await complete(store); await store.release();
  const other = make({campaign: join(options.campaign, '..', 'other'), protocolHash: digest('different')});
  await other.acquire(); t.after(() => other.release()); await assert.rejects(other.restoreCompleted(), /protocol mismatch/);
});
test('exclusive checkpoint creation refuses to overwrite an earlier outcome', async t => {
  const {store} = await fixture(t); await store.acquire(); t.after(() => store.release()); const row = await complete(store);
  await assert.rejects(store.checkpoint({...row, officialRuntimeSuccess: false}, []), {code: 'EEXIST'});
});
test('credentials in files or derived metadata prevent public checkpoint publication', async t => {
  const {store} = await fixture(t); await store.acquire(); t.after(() => store.release()); await store.begin(slot);
  await atomicJson(join(store.campaign, name, 'model-exit.json'), {code: 0});
  const key = 'DURABLE_CONTROL_API_KEY', value = 'synthetic-credential-for-control'; process.env[key] = value;
  t.after(() => delete process.env[key]);
  await assert.rejects(store.checkpoint({...slot, name, hashes: {}, error: value}, []), /credential/);
  await writeFile(join(store.campaign, name, 'stderr.log'), value);
  await assert.rejects(store.checkpoint({...slot, name, hashes: {}}, []), /credential/);
  await assert.rejects(readFile(join(store.checkpoints, name + '.json.gz')), {code: 'ENOENT'});
});
test('a live lease prevents a second campaign driver', async t => {
  const {store, options} = await fixture(t); await store.acquire(); t.after(() => store.release());
  await assert.rejects(new DurableCampaign(options).acquire(), /still alive/);
});
test('real SIGKILL recovers the dead driver lease but refuses to retry its uncertain model invocation', {timeout: 10000}, async t => {
  const {options, make} = await fixture(t);
  const source = `import {DurableCampaign} from ${JSON.stringify(new URL('./durable-campaign.mjs', import.meta.url).href)};const s=new DurableCampaign(${JSON.stringify(options)});await s.acquire();await s.begin(${JSON.stringify(slot)});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL')); await once(child.stdout, 'data'); const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const resumed = make(); await resumed.acquire(); t.after(() => resumed.release());
  await assert.rejects(resumed.inspect(slot), UncertainTrialError);
});
