"""Selected candidate four only; never call the canonical eight-actor run_all."""
import argparse,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'controller'))
import run
from policy import GO_KEYS,authorize,jobs,load,publish,sha,stop_check
KEYS=['candidate-codex-C01','candidate-claude-C01','candidate-claude-C02','candidate-codex-C02']

def selection(out):
 out=Path(out);seal=load(out/'seal.json');all_jobs=jobs(load(seal['cases_path'])['cases'])
 keys=[j['key'] for j in all_jobs if j['variant']=='candidate']
 if len(all_jobs)!=8 or keys!=KEYS:raise RuntimeError('Exact canonical C01/C02 candidate four required')
 history=load(ROOT/'historical-baseline.json');rows=history['rows']
 if history.get('never_rerun') is not True or {r['key'] for r in rows}!=set(KEYS) or len(rows)!=4:raise RuntimeError('Historical four binding invalid')
 for row in rows:
  for p,digest in row['artifacts_sha256'].items():
   if sha(p)!=digest:raise RuntimeError('Historical actor changed')
 return seal,keys

def freeze(out):
 out=Path(out);seal,keys=selection(out)
 manifest=ROOT.parent/'post-commit-build/manifest.json'
 s={'adapter_path':str(Path(__file__).resolve()),'adapter_sha256':sha(__file__),'tests_sha256':sha(ROOT/'test_selected4.py'),'canonical_seal_sha256':sha(out/'seal.json'),'historical_baseline_sha256':sha(ROOT/'historical-baseline.json'),'postcommit_manifest_sha256':sha(manifest),'selected_keys':keys,'execute_actor_count':4,'historical_baseline_actor_count':4,'canonical_static_profiles':8,'inert_baseline_profiles_never_proved_or_run':True}
 publish(out/'selected4-seal.json',s)
 common={k:v for k,v in s.items() if k!='adapter_path'}|{'selected4_seal_sha256':sha(out/'selected4-seal.json')}
 publish(out/'ROOTGO-selected4-template.json',{**{k:seal[k] for k in GO_KEYS},**common,'ROOTGO':False})
 publish(out/'ROOT-NATIVE-GO-selected4-template.json',{**common,'ROOT_NATIVE_GO':False,'keys':keys,'seal_sha256':sha(out/'seal.json'),'model_turns':0})

def verify(out,go_path,native=False,key=None):
 out=Path(out);seal,keys=selection(out);s=load(out/'selected4-seal.json');go=load(go_path)
 if key is not None and key not in KEYS:raise PermissionError('Historical/baseline actor is forbidden')
 if s['adapter_sha256']!=sha(__file__) or s['tests_sha256']!=sha(ROOT/'test_selected4.py') or s['canonical_seal_sha256']!=sha(out/'seal.json') or s['historical_baseline_sha256']!=sha(ROOT/'historical-baseline.json') or s['postcommit_manifest_sha256']!=sha(ROOT.parent/'post-commit-build/manifest.json'):raise RuntimeError('Selected controller/source binding changed')
 for field in s:
  if field!='adapter_path' and go.get(field)!=s[field]:raise PermissionError('Selected4 GO mismatch: '+field)
 if go.get('selected4_seal_sha256')!=sha(out/'selected4-seal.json'):raise PermissionError('Selected4 seal mismatch')
 review=load(ROOT/'independent-review.json');window=load(ROOT/'window-release.json')
 if review.get('status')!='PASS' or review.get('selected4_seal_sha256')!=sha(out/'selected4-seal.json'):raise PermissionError('Independent review PASS required')
 if window.get('early16_terminal') is not True or window.get('release_for_startup4') is not True:raise PermissionError('Early16 window is not released')
 stop_check(out)
 for stage in ['METADATA','RUN']:
  if (out/('SELECTED4-'+stage+'-STOP.json')).exists():raise RuntimeError('Selected4 stopped; no retry')
 if native:
  if go.get('ROOT_NATIVE_GO') is not True or go.get('keys')!=keys or go.get('seal_sha256')!=sha(out/'seal.json'):raise PermissionError('Exact candidate-four metadata GO required')
 else:authorize(go,seal,key or keys[0])
 return keys

def run_key(out,key,go,native=False):
 verify(out,go,native,key)
 return run.prove(out,key,go) if native else run.run_one(out,key,go)

def execute(out,go,native=False):
 out=Path(out);keys=verify(out,go,native);stage='METADATA' if native else 'RUN';prefix='SELECTED4-'+stage
 publish(out/(prefix+'-STARTED.json'),{'go_sha256':sha(go),'selected_keys':keys,'execute_actor_count':4,'time_ns':time.time_ns(),'concurrency':1})
 complete=[]
 try:
  for key in keys:
   t=time.monotonic();run_key(out,key,go,native);complete.append(key)
   print(json.dumps({'key':key,'status':'ready' if native else 'completed','completed':len(complete),'target':4,'wall_seconds':time.monotonic()-t}),flush=True)
 except BaseException as error:
  publish(out/(prefix+'-STOP.json'),{'failed_key':key,'completed':complete,'error':str(error),'retry':False});raise
 publish(out/(prefix+'-COMPLETED.json'),{'completed_keys':complete,'execute_actor_count':4,'historical_baseline_actors_rerun':0,'model_turns':0 if native else 'native accounting','quality':'UNGRADED'})

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action',choices=['freeze','prove','run']);p.add_argument('--out',type=Path,required=True);p.add_argument('--go',type=Path);a=p.parse_args()
 if a.action=='freeze':freeze(a.out)
 elif not a.go:p.error('--go required')
 else:execute(a.out,a.go,a.action=='prove')
