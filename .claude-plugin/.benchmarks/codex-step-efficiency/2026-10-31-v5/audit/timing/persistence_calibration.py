"""Run under explicit alternate interpreter; never touch originals or prior reports."""
import json,sys,tempfile,pathlib,hashlib,platform
from persistence_replay import BASE,ROOT,OUT,direct
result={'python':{'executable':sys.executable,'version':sys.version,'platform':platform.platform()},'script_sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'replay_script_sha256':hashlib.sha256((OUT/'persistence_replay.py').read_bytes()).hexdigest(),'replays':[]}
with tempfile.TemporaryDirectory(prefix='alternate-python-',dir=OUT) as tmp:
 dest=pathlib.Path(tmp)/'partial.json'
 def question(qid):
  for name,r in BASE['runs'].items():
   q=next(q for q in r['questions'] if q['id']==qid);raw=(ROOT/q['source']).read_bytes();assert hashlib.sha256(raw).hexdigest()==q['sha256'];row={'run':name,'question_id':qid,**direct(json.loads(raw),dest)};result['replays'].append(row);(OUT/'controller-persistence-hypothesis-python315.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(row),flush=True)
 question('Q01')
 if max(r['wall_seconds'] for r in result['replays'])<5:
  for i in range(2,40):question(f'Q{i:02d}')
 else:result['rest_unrun_reason']='Q01 exceeded cheap calibration threshold (5s); no automatic broad alternate replay.'
 (OUT/'controller-persistence-hypothesis-python315.json').write_text(json.dumps(result,indent=2)+'\n')
