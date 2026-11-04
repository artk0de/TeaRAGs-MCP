from pathlib import Path
import sys,importlib.util,json,subprocess,time
h=Path(sys.argv[1]).resolve()/'harness'
spec=importlib.util.spec_from_file_location('stage_controller',h/'isolated.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
seal=m.load(h/'bundle-manifest.json');jobs=m.load(h/'schedule.json');shared=m.load(h/'shared-manifest.json')
assert 0<len(jobs)<=5 and len(jobs)==seal['max_model_turns'] and len({j['home_key'] for j in jobs})==len(jobs)
assert all(j['condition']=='A' for j in jobs) and len(shared['backend_frozen_files'])==7879
assert (seal['model'],seal['effort'],seal['n'])==('gpt-6.1-sol','medium',1)
for j in jobs:
    p=m.load(h/'profiles'/j['home_key']/'no-turn-proof/summary.json')
    assert (p['tools'],p['skills'],p['trusted_hooks'],p['plugins'],p['model_turns'],p['home_pristine'])==(17,18,14,1,0,True)
m.validate_before_actor(jobs[0],seal)
go={k:seal[k] for k in m.BOUND_KEYS};go.update(ROOTGO=True,user_authorization='оптимизируй: affected native behavioral evals only',conditions=['A'],approved_time_ns=time.time_ns());m.authorize(go,seal);m.checkpoint(h/'ROOTGO.json',go)
with (h/'campaign.log').open('x') as log:
    p=subprocess.Popen(['/opt/homebrew/bin/python3',str(h/'isolated.py'),'run','--rootgo',str(h/'ROOTGO.json')],cwd='/Users/artk0re/Dev/Tools/tea-rags-mcp',stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
launch={'pid':p.pid,'conditions':['A'],'selected':[j['id'] for j in jobs],'model':seal['model'],'effort':seal['effort'],'n':1,'rootgo_sha256':m.sha(h/'ROOTGO.json'),'started_time_ns':time.time_ns()};m.checkpoint(h/'launch.json',launch);print(json.dumps(launch))
