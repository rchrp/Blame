import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function sourceEpoch(root){
 const paths=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).split('\0').filter(Boolean))].sort();
 const h=createHash('sha256');let files=0;
 for(const path of paths){
  if(path==='node_modules'||path.startsWith('node_modules/')||path.startsWith('.blame/'))continue;
  h.update(path+'\0');
  try{const s=lstatSync(join(root,path));h.update(String(s.mode)+'\0');if(s.isSymbolicLink())h.update('symlink:'+readlinkSync(join(root,path)));else if(s.isFile()){if(s.size>4*1024*1024)throw Error('Source fingerprint file limit');h.update(readFileSync(join(root,path)));files++;}else h.update('non-file');}
  catch(e){if(e.code!=='ENOENT')throw e;h.update('deleted');}h.update('\0');
 }return {version:2,sha256:h.digest('hex'),files};
}
