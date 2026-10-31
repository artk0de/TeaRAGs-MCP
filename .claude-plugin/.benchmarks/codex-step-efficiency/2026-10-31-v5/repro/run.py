"""Root-only launcher: one fresh A only; refuses resume/retry/overwrite."""
import argparse
import json
import os
from pathlib import Path
import sys
from controller_io import require_controller_python, verify_runtime

def main():
 p=argparse.ArgumentParser();p.add_argument('--base',type=Path,required=True);p.add_argument('--rootgo',action='store_true',required=True);args=p.parse_args()
 base=args.base.resolve();manifest=json.loads((base/'final-manifest.json').read_text())
 assert args.rootgo and not manifest['ROOTGO']
 assert manifest['order']==['A'] and manifest['runs_authorized']==['A'] and manifest['runs_per_condition']==1
 require_controller_python();verify_runtime(manifest['controller_python'])
 assert manifest['model']=='gpt-6.1-sol' and manifest['effort']=='medium'
 assert manifest['prepared_model_turns']==0 and manifest['preflight_ready']
 for name in ['independent-review.json','focused-cases.json','transport-preservation.json']:
  evidence=json.loads((base/name).read_text());assert evidence['verdict']=='PASS',name
  assert evidence['frozen_files_sha256']==fingerprint(manifest['frozen_files']), 'Evidence belongs to another snapshot: '+name
 assert not (base/'runs').exists(),'Never repeat or resume actors'
 for cell in ['A']:assert not (base/'homes'/cell/'sessions').exists(),'Actor home not fresh'
 sys.path.insert(0,str(base/'lib'))
 import codex61_runner as runner
 runner.configure(base);runner.verify_frozen(manifest)
 # Atomic ROOTGO token survives crashes and consumes the single A authorization.
 fd=os.open(base/'ROOTGO.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as stream:json.dump({'rootgo':True,'source':'Explicit root --rootgo launch','runs_authorized':['A'],'retries':0},stream)
 manifest.update(ROOTGO=True,independent_security_review='ready',focused_cases='PASS',transport_preservation='PASS')
 (base/'final-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 runner.execute('A')

def fingerprint(files):
 import hashlib
 return hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
if __name__=='__main__':main()
