import {execFileSync} from 'node:child_process';import {lstatSync} from 'node:fs';import {join} from 'node:path';
export function sourcePermissions(root){
 const paths=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).split('\0').filter(Boolean))].sort(),overrides={};
 for(const path of paths){if(path.startsWith('.blame/')||path.startsWith('node_modules/'))continue;try{const s=lstatSync(join(root,path)),mode=s.mode&0o7777;if(s.isFile()&&![0o600,0o700].includes(mode))overrides[path]=mode;}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {version:1,overrides,boundary:'POSIX permissions beyond Git executable bits; no source bytes. Original exact fingerprint remains the replay authority.'};
}
