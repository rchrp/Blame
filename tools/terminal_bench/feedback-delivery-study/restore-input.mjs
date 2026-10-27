// Replay-only source restoration. No remote access and no model calls.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest} from '../durable-campaign.mjs';
import {work, study} from './inputs.mjs';
export async function restoreInput(root, task, protocol, {portable = false} = {}) {
  await mkdir(root, {recursive: true});
  const archive = join(work, 'inputs', task + '.tar.gz');
  const bytes = portable ? null : await readFile(archive).catch(e => {if (e.code === 'ENOENT') return null; throw e;});
  if (bytes) {
    assert.equal(digest(bytes), protocol.inputs[task].archiveSha256);
    execFileSync('tar', ['-xzf', archive, '-C', root]);
  } else {
    const bundle = join(study, 'inputs', 'original-inputs.bundle');
    const manifest = JSON.parse(await readFile(join(study, 'inputs', 'manifest.json')));
    assert.equal(digest(await readFile(bundle)), manifest.bundleSha256);
    // Four original input commits share objects in one bundle. The bundle has
    // no model patches, researcher solutions, dependency tree or remote history.
    execFileSync('git', ['clone', '--quiet', '--branch', task, bundle, root]);
    await writeFile(join(root, '.git/info/exclude'), '.blame/\nnode_modules\n');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(head, protocol.inputs[task].head);
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim(), '');
}
