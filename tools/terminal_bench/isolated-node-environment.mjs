// Opt-in preparation for future campaigns. F42's registered workers are unchanged.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,lstat,mkdir,readFile,readdir,readlink,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
const sha=x=>createHash('sha256').update(x).digest('hex');
const inside=(root,path)=>{const r=relative(root,path);return r===''||!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r);};
export async function dependencyManifest(root){
 const records={};
 for(const entry of await readdir(root,{recursive:true,withFileTypes:true})){
  const path=join(entry.parentPath,entry.name),key=relative(root,path).split(sep).join('/');
  if(entry.isFile())records[key]={kind:'file',sha256:sha(await readFile(path))};
  else if(entry.isSymbolicLink())records[key]={kind:'symlink',target:await readlink(path)};
 }
 return Object.fromEntries(Object.entries(records).sort(([a],[b])=>a.localeCompare(b)));
}
export async function prepareIsolatedNodeEnvironment({baselineModules,workspace,cacheRoot}){
 const baseline=resolve(baselineModules),destination=join(resolve(workspace),'node_modules'),cache=resolve(cacheRoot);
 assert.ok(!inside(baseline,destination)&&!inside(destination,baseline),'Source and destination must be disjoint');
 assert.ok(!inside(destination,cache)&&!inside(cache,destination)&&!inside(baseline,cache)&&!inside(cache,baseline),'npm cache and dependencies must be disjoint');
 await lstat(destination).then(()=>{throw Error('Refusing to replace existing dependencies');},e=>{if(e.code!=='ENOENT')throw e;});
 await lstat(cache).then(()=>{throw Error('Refusing to reuse an existing npm cache');},e=>{if(e.code!=='ENOENT')throw e;});
 // Node/npm can resolve an undeclared tool from an ancestor even with a fresh
 // offline npm cache. Future trial workspaces must live outside the host repo.
 for(let parent=dirname(resolve(workspace));;parent=dirname(parent)){
  await lstat(join(parent,'node_modules')).then(()=>{throw Error('Ancestor dependencies are reachable; use a separate temporary workspace');},e=>{if(e.code!=='ENOENT')throw e;});
  if(parent===dirname(parent))break;
 }
 const manifest=await dependencyManifest(baseline);
 for(const [path,value]of Object.entries(manifest))if(value.kind==='symlink'){
  assert.ok(!isAbsolute(value.target)&&inside(baseline,resolve(baseline,path,'..',value.target)),`External dependency link cannot be isolated: ${path}`);
 }
 // Preserve relative executable links: fs.cp's default can resolve them back
 // into the original tree, silently sharing mutable package bytes again.
 try{await cp(baseline,destination,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});assert.deepEqual(await dependencyManifest(destination),manifest);await mkdir(cache,{recursive:true});}
 catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 return {manifest,env:{npm_config_cache:cache,npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'},
  policy:'Per-trial copied dependencies and isolated empty npm cache; offline execution refuses undeclared tool downloads. Apply identically to every arm before registration.'};
}
export function compareDependencyManifests(before,after){
 const changed=[],missing=[],added=[],generated=[],generatedModified=[];
 for(const [path,value]of Object.entries(before)){
  if(!(path in after))missing.push(path);
  else if(JSON.stringify(value)!==JSON.stringify(after[path])){
   // Vitest updates this non-executable result data even when the copied
   // dependency tree already has a cache. Keep modifications visible without
   // calling them package changes. Kind changes/symlinks remain deviations.
   if(/^\.vite\/vitest\/[a-f0-9]{40}\/results\.json$/.test(path)&&value.kind==='file'&&after[path].kind==='file')generatedModified.push(path);
   else changed.push(path);
  }
 }
 for(const path of Object.keys(after))if(!(path in before)){
  if(/^(?:\.vite|\.vitest-cache|\.cache)\//.test(path))generated.push(path);else added.push(path);
 }
 return {pinnedDependenciesUnchanged:changed.length===0&&missing.length===0&&added.length===0,changed,missing,added,generated,generatedModified};
}
