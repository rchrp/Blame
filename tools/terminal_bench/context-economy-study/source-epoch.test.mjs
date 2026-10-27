import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,unlink,chmod,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {sourceEpoch} from './source-epoch.mjs';
test('source fingerprints include file bytes, modes, deletion and symlink targets; ignored caches stay out',async()=>{
 const root=await mkdtemp(join(tmpdir(),'source-epoch-'));try{
  execFileSync('git',['init','--quiet'],{cwd:root});await writeFile(join(root,'.git/info/exclude'),'node_modules/\n.study/reports/\n');
  await writeFile(join(root,'a.ts'),'export const a=1;');await symlink('a.ts',join(root,'alias.ts'));execFileSync('git',['add','.'],{cwd:root});
  const initial=sourceEpoch(root).sha256;
  await mkdir(join(root,'.study/reports'),{recursive:true});await writeFile(join(root,'.study/reports/cache'),'generated');assert.equal(sourceEpoch(root).sha256,initial);
  await unlink(join(root,'alias.ts'));await symlink('b.ts',join(root,'alias.ts'));assert.notEqual(sourceEpoch(root).sha256,initial);
  await unlink(join(root,'alias.ts'));await symlink('a.ts',join(root,'alias.ts'));assert.equal(sourceEpoch(root).sha256,initial);
  await chmod(join(root,'a.ts'),0o755);const mode=sourceEpoch(root).sha256;assert.notEqual(mode,initial);
  await writeFile(join(root,'a.ts'),'export const a=2;');assert.notEqual(sourceEpoch(root).sha256,mode);
  const changed=sourceEpoch(root).sha256;await unlink(join(root,'a.ts'));assert.notEqual(sourceEpoch(root).sha256,changed);
 }finally{await rm(root,{recursive:true,force:true});}
});
