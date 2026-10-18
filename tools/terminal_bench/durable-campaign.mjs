// Research persistence, outside measured workers. Never retries an uncertain call.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {open, mkdir, readFile, readdir, rename, unlink, link, rm} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {hostname} from 'node:os';
import {gzipSync, gunzipSync} from 'node:zlib';

export const digest = value => createHash('sha256').update(value).digest('hex');
const exists = async path => readFile(path).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const identity = async () => ({host: hostname(), boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()});
export const trialName = slot => `${slot.repeat}-${slot.task}-${slot.arm}`;
function safeName(name) {assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/); return name;}
async function syncDirectory(path) {const handle = await open(path, 'r'); try {await handle.sync();} finally {await handle.close();}}

export async function atomicWrite(path, bytes, {exclusive = false} = {}) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  try {if (exclusive) {await link(temporary, path); await unlink(temporary);} else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {await rm(temporary, {force: true});}
}
export const atomicJson = (path, value, options) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n', options);

export class UncertainTrialError extends Error {
  constructor(name) {super(`Trial ${name} started without a recorded model exit. Refusing another model call; preserve its unknown consumption and inspect the retained files.`); this.code = 'UNCERTAIN_MODEL_INVOCATION'; this.trial = name;}
}

export class DurableCampaign {
  constructor({campaign, study, protocol, protocolHash}) {
    this.campaign = campaign; this.study = study; this.protocol = protocol; this.protocolHash = protocolHash;
    this.names = protocol.order.map(trialName); assert.equal(new Set(this.names).size, this.names.length);
    this.names.forEach(safeName); this.checkpoints = join(study, 'checkpoints');
  }
  async acquire() {
    await mkdir(this.campaign, {recursive: true}); await mkdir(this.checkpoints, {recursive: true});
    const path = join(this.campaign, 'driver-lease.json'), id = await identity();
    const owner = {...id, pid: process.pid, token: randomUUID(), atUTC: new Date().toISOString()};
    try {await atomicJson(path, owner, {exclusive: true});}
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recoveryLock = join(this.campaign, 'lease-recovery.lock');
      await mkdir(recoveryLock); // Serialize stale-lock recovery; a crash here fails closed.
      try {
        const previous = await readJson(path);
        // Different hosts/boots need human evidence, not a guessed stale lock.
        assert.equal(previous.host, id.host, 'Lease belongs to another host; inspect before recovery');
        assert.equal(previous.boot, id.boot, 'Lease belongs to another boot; inspect before recovery');
        try {process.kill(previous.pid, 0); throw Error('Campaign driver is still alive');}
        catch (failure) {if (failure.code !== 'ESRCH') throw failure;}
        await atomicJson(join(this.campaign, `recovered-lease-${randomUUID()}.json`), {previous, recovery: owner});
        await unlink(path); await atomicJson(path, owner, {exclusive: true});
      } finally {await rm(recoveryLock, {recursive: true});}
    }
    this.owner = owner;
    try {
      const manifest = {version: 1, protocolHash: this.protocolHash, names: this.names};
      const file = join(this.campaign, 'durable-inputs.json');
      if (await exists(file)) assert.deepEqual(await readJson(file), manifest, 'Campaign inputs changed');
      else await atomicJson(file, manifest, {exclusive: true});
    } catch (error) {await this.release(); throw error;}
  }
  async release() {
    if (!this.owner) return;
    const path = join(this.campaign, 'driver-lease.json');
    assert.equal((await readJson(path)).token, this.owner.token, 'Lease owner changed');
    await unlink(path); await syncDirectory(this.campaign); this.owner = null;
  }
  assertOwned(name) {assert.ok(this.owner, 'Acquire campaign lease'); assert.ok(this.names.includes(name), 'Unassigned trial');}
  async inspect(slot) {
    const name = trialName(slot); this.assertOwned(name);
    const checkpoint = join(this.checkpoints, name + '.json.gz');
    if (await exists(checkpoint)) return {state: 'complete', ...await this.readCheckpoint(name)};
    const directory = join(this.campaign, name);
    if (await exists(join(directory, 'model-start.json'))) {
      if (await exists(join(directory, 'model-exit.json'))) return {state: 'finalize', name, directory};
      const files = (await readdir(directory, {withFileTypes: true})).filter(e => e.isFile()).map(e => e.name).sort();
      await atomicJson(join(this.study, 'interrupted-trial.json'), {name, protocolHash: this.protocolHash,
        observedAtUTC: new Date().toISOString(), state: 'model_exit_unknown', files,
        sdkObservedUsd: null, schedulingReserveUsd: this.protocol.budgets.perTrialSdkCostLimitUsd + this.protocol.budgets.requestOvershootReserveUsd,
        reservationBoundary: 'Scheduling allowance only, not a measured charge or invoice bound. Partial receipts remain in the durable trial directory; reconcile before any new campaign.',
        modelRetried: false});
      throw new UncertainTrialError(name);
    }
    return {state: 'unstarted', name, directory};
  }
  async begin(slot) {
    const name = trialName(slot); this.assertOwned(name);
    await atomicJson(join(this.campaign, name, 'model-start.json'), {slot, protocolHash: this.protocolHash,
      startedAtUTC: new Date().toISOString(), executionHost: await identity()}, {exclusive: true});
  }
  async checkpoint(row, wire) {
    const name = row.name; this.assertOwned(name); assert.equal(name, trialName(row));
    const directory = join(this.campaign, name), files = {};
    assert.ok(await exists(join(directory, 'model-exit.json')), 'Record model exit before checkpoint');
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (!entry.isFile() || ['workspace.tar.gz', 'generated-caches.tar.gz'].includes(entry.name)) continue;
      const bytes = await readFile(join(directory, entry.name));
      for (const [key, value] of Object.entries(process.env))
        if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key) && value.length >= 16)
          assert.ok(!bytes.includes(Buffer.from(value)), 'Configured credential found; refuse checkpoint publication');
      files[entry.name] = {bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64')};
    }
    for (const [path, hash] of Object.entries(row.hashes)) assert.equal(files[path]?.sha256 ?? null, hash);
    const serialized = JSON.stringify({version: 1, name, protocolHash: this.protocolHash, row, wire, files});
    for (const [key, value] of Object.entries(process.env))
      if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/.test(key) && value.length >= 16)
        assert.ok(!serialized.includes(JSON.stringify(value).slice(1, -1)), 'Configured credential found in metadata; refuse checkpoint publication');
    const archive = gzipSync(serialized, {mtime: 0});
    await atomicWrite(join(this.checkpoints, name + '.json.gz'), archive, {exclusive: true});
    return this.readCheckpoint(name);
  }
  async readCheckpoint(name) {
    safeName(name);
    const bytes = await readFile(join(this.checkpoints, name + '.json.gz'));
    const archive = JSON.parse(gunzipSync(bytes));
    assert.equal(archive.version, 1); assert.equal(archive.protocolHash, this.protocolHash, 'Checkpoint protocol mismatch');
    assert.equal(archive.name, name); assert.equal(archive.row.name, name);
    for (const [path, file] of Object.entries(archive.files)) {
      assert.ok(!path.includes('/') && !path.includes('\\') && path !== '..');
      const b = Buffer.from(file.base64, 'base64'); assert.equal(b.length, file.bytes); assert.equal(digest(b), file.sha256);
    }
    for (const [path, hash] of Object.entries(archive.row.hashes)) assert.equal(archive.files[path]?.sha256 ?? null, hash);
    return {name, row: archive.row, wire: archive.wire, files: archive.files, sha256: digest(bytes)};
  }
  async restoreCompleted() {
    const rows = [], wireByTrial = {}, receipts = []; let gap = false;
    for (const name of this.names) {
      if (!(await exists(join(this.checkpoints, name + '.json.gz')))) {gap = true; continue;}
      assert.equal(gap, false, 'Checkpoint ordering gap');
      const c = await this.readCheckpoint(name); rows.push(c.row); wireByTrial[name] = c.wire;
      const directory = join(this.campaign, name); await mkdir(directory, {recursive: true});
      for (const [path, file] of Object.entries(c.files)) {
        const target = join(directory, path), bytes = Buffer.from(file.base64, 'base64');
        if (await exists(target)) assert.equal(digest(await readFile(target)), file.sha256, 'Completed trial changed');
        else await atomicWrite(target, bytes, {exclusive: true});
      }
      receipts.push({name, sha256: c.sha256});
    }
    await atomicJson(join(this.study, 'checkpoint-index.json'), {protocolHash: this.protocolHash,
      completed: rows.length, planned: this.names.length, receipts, note: 'Derived index. Each immutable archive is independently verified; no model call is replayed.'});
    return {rows, wireByTrial};
  }
}
