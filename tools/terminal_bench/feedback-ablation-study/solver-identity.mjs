// Linux fixture identity: solver code is statically embedded in this binary;
// hash every file-backed dynamic dependency reported by ldd as well.
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {sha} from './setup.mjs';
export async function solverIdentity(path){
 assert.equal(process.platform,'linux','This frozen solver environment is Linux-specific');
 const resolved=await realpath(path),ldd=execFileSync('ldd',[resolved],{encoding:'utf8'});
 const paths=[...new Set([...ldd.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match=>match[1]))].sort();
 assert.ok(paths.length>0,'Expected explicit dynamic dependencies');
 const libraries={};for(const library of paths)libraries[library]={realpath:await realpath(library),sha256:sha(await readFile(library))};
 return{path,resolvedPath:resolved,sha256:sha(await readFile(path)),version:execFileSync(path,['-version'],{encoding:'utf8'}).trim(),package:'z3-solver==4.15.4.0',libraries,virtualDependencies:['linux-vdso.so.1 is kernel-provided and has no file hash; kernel release is recorded separately']};
}
