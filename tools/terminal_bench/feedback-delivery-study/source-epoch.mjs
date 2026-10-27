import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
// Metadata-only observation, not a compiler-selection or environment proof.
export function sourceEpoch(root){
 const paths=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).split('\0').filter(Boolean))].sort();
 const h=createHash('sha256');let files=0;
 for(const path of paths){
  if(path==='node_modules'||path.startsWith('node_modules/')||path.startsWith('.blame/'))continue;
  h.update(path+'\0');
  try{const stat=lstatSync(join(root,path));if(!stat.isFile()){h.update('non-file\0');continue;}if(stat.size>4*1024*1024)throw Error('Source fingerprint file limit');h.update(readFileSync(join(root,path)));files++;}catch(e){if(e.code!=='ENOENT')throw e;h.update('deleted');}
  h.update('\0');
 }
 return {sha256:h.digest('hex'),files};
}
