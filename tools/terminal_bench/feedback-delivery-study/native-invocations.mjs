// Observe literal successful npm invocations only. Shell success is not a
// compiler-selection proof; masking and diagnostic errors remain excluded.
export function successfulNativeInvocations(output){
 const found=[];
 for(const value of Array.isArray(output)?output:[output]){
  if(value?.success!==true||/error TS\d+|(?:^|\n)\s*(?:FAIL|Error:)/u.test(typeof value.result==='string'?value.result:JSON.stringify(value.result??'')))continue;
  let query=value.query;
  if(query&&typeof query==='object'&&query.command==='npm'&&Array.isArray(query.args)&&query.args.length===2&&query.args[0]==='run')query='npm run '+query.args[1];
  if(typeof query!=='string')continue;
  const parts=query.trim().split(/\s*&&\s*/u);
  const matches=parts.map(part=>/^npm\s+run\s+(['"]?)([A-Za-z0-9:_-]+)\1$/u.exec(part));
  if(matches.every(Boolean))found.push(...matches.map(match=>'npm run '+match[2]));
 }
 return found;
}
