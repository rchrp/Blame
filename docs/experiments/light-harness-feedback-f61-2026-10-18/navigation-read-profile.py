"""Post-hoc recorded read-tool inventory; never a token/causality estimator."""
import hashlib,json,sys
from pathlib import Path
base=Path(sys.argv[1]); out=Path(sys.argv[2]); analysis=json.loads((base/'campaign/analysis.json').read_text());rows=[]
for trial in analysis['rows']:
 p=base/'campaign'/trial['name']/'tool-ledger.json'; ts=json.loads(p.read_text()); calls=[]
 root=str(base/'campaign'/trial['name']/'workspace')+'/'
 for i,t in enumerate(ts):
  inp=t.get('input',{})
  if t['tool']=='read_code':
   inputs=[{'target':str(inp.get('target','')).removeprefix(root),'view':inp.get('view','default'),'range':inp.get('range')}]
  elif t['tool']=='read_files':
   inputs=[{'target':str(f.get('path','')).removeprefix(root),'view':'range' if f.get('start_line') or f.get('end_line') else 'whole-file','startLine':f.get('start_line'),'endLine':f.get('end_line')} for f in inp.get('files',[])]
  else:continue
  calls.append({'toolIndex':i,'tool':t['tool'],'inputs':inputs,'recordedOutputJsonBytes':len(json.dumps(t.get('output'),ensure_ascii=False,separators=(',',':')).encode())})
 rows.append({'name':trial['name'],'arm':trial['arm'],'ledgerSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'readCalls':len(calls),'readSelections':sum(len(c['inputs']) for c in calls),'recordedOutputJsonBytes':sum(c['recordedOutputJsonBytes'] for c in calls),'calls':calls})
out.write_text(json.dumps({'status':'complete' if len(rows)==18 else 'partial','method':'Exploratory post-hoc inventory of explicit read_code/read_files calls from complete immutable ledgers. Bytes serialize the recorded output JSON compactly in UTF-8; batching, formatting and recorder redaction differ between tools. These are not forwarded request bytes, billed tokens, cache misses, semantic relevance, total information exposure or a causal explanation of arm resource differences. Shell reads/search/edit/validation outputs are deliberately outside this narrow inventory; do not treat missing read calls as no reading. All primary acceptance/resource criteria remain unchanged.','rows':rows},indent=2)+'\n')
