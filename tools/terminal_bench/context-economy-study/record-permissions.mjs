// Recover metadata only from the immutable, hash-bound end-of-run snapshot.
// Git patches retain executable bits, not owner/group permission differences.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {evidence,file} from './evidence.mjs';import {work,study} from './inputs.mjs';import {atomicJson,digest} from '../durable-campaign.mjs';
const {records,executionFinished,protocolHash}=await evidence();assert.equal(executionFinished,true);const trials={};
const script=`import tarfile,json,sys
out={}
with tarfile.open(sys.argv[1]) as arc:
 for m in arc.getmembers():
  p=m.name.removeprefix('./')
  if not m.isfile() or p.startswith(('.git/','.blame/','node_modules/')):continue
  assert not p.startswith('/') and '..' not in p.split('/')
  assert m.mode & 0o7000 == 0
  if m.mode not in (0o600,0o700):out[p]=m.mode
print(json.dumps(dict(sorted(out.items()))))
`;
for(const c of records){
 const path=join(work,'campaign',c.name,'workspace.tar.gz'),archive=JSON.parse(file(c,'workspace-archive.json'));assert.equal(digest(await readFile(path)),archive.sha256);
 const overrides=JSON.parse(execFileSync('python3',['-c',script,path],{encoding:'utf8',maxBuffer:2*1024*1024}));trials[c.name]={checkpointSha256:c.receipt.sha256,workspaceArchiveSha256:archive.sha256,sourceSha256:JSON.parse(file(c,'source-at-exit.json')).sha256,overrides};
}
await atomicJson(join(study,'source-permissions.json'),{protocolHash,trials,boundary:'Permission metadata only, derived after dispatch from each hash-bound original workspace snapshot. No source bytes, patches or scores are changed. Replays apply the original patch plus these POSIX-mode overrides, then require the original exact source fingerprint.'},{exclusive:true});console.log('Recovered original permission metadata for '+records.length+' immutable patches.');
