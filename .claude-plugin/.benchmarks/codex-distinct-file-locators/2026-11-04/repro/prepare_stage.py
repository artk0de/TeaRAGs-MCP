"""Prepare fresh A-only profiles; no model request. Independent selected cases."""
from pathlib import Path
import argparse,json,re,shutil,subprocess
p=argparse.ArgumentParser();p.add_argument('--base',required=True,type=Path);p.add_argument('--source',required=True,type=Path);p.add_argument('--selected',required=True);p.add_argument('--policy-source',type=Path);p.add_argument('--runtime-manifest',required=True,type=Path);a=p.parse_args();base=a.base.resolve();wt=a.source.resolve();policy=(a.policy_source or wt).resolve()
root=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp');template=Path('/Users/Shared/nav-ab/context-efficiency-0555-evals/stage1/harness');old=Path('/Users/Shared/nav-ab/gruntworx-A0554-isolated-20261103-01/source');backend=json.loads(a.runtime_manifest.read_text());runtime=Path(backend['runtime_root']);suite=wt/'.claude-plugin/.benchmarks/codex-distinct-file-locators/2026-11-04'
keep=sorted(a.selected.split(','));assert 0<len(keep)<=5 and len(set(keep))==len(keep)
assert (wt/'src/mcp/resources/generated/agent-context.ts').read_bytes()==(old/'final-runtime/src/mcp/resources/generated/agent-context.ts').read_bytes(),'Shared bootstrap changed; this adapter requires a separate injection audit'
assert backend['plugin_version']=='0.55.8' and len(backend['frozen_files'])==7879
base.mkdir(parents=True,mode=0o700,exist_ok=False);h=base/'harness';h.mkdir();(h/'evidence').mkdir();(h/'checkpoints').mkdir();(base/'cases').mkdir();(base/'review').mkdir();archive=base/'source';archive.mkdir()
shutil.copytree(old/'lib',archive/'lib',ignore=shutil.ignore_patterns('__pycache__'));(archive/'final-runtime').symlink_to(runtime.resolve(),target_is_directory=True)
for name in ['upstream-template.json','corpus-readable-inventory.json']:shutil.copyfile(old/name,archive/name)
m=backend.copy();m['frozen_files']={str(archive/'final-runtime')+'/'+str(Path(s).relative_to(runtime)):v for s,v in m['frozen_files'].items()};m['policy_source']='Immutable generated snapshot';(archive/'final-manifest.json').write_text(json.dumps(m,indent=2)+'\n');shutil.copyfile(a.runtime_manifest.parent/'backend-source.patch',archive/'backend-source.patch')
market=archive/'final-marketplace';(market/'harness').mkdir(parents=True);shutil.copytree(policy/'harness/codex',market/'harness/codex');shutil.copytree(policy/'.agents',market/'.agents')
cs=json.loads((suite/'cases.json').read_text());cs['cases']=[x for x in cs['cases'] if x['id'] in keep];assert sorted(x['id'] for x in cs['cases'])==keep;(base/'cases/cases.json').write_text(json.dumps(cs,ensure_ascii=False,indent=2)+'\n');shutil.copyfile(suite/'grading.json',base/'review/grading.json')
s=(template/'isolated.py').read_text();s=re.sub(r'^KEEP=.*$', 'KEEP='+repr(keep),s,flags=re.M);s=re.sub(r'len\(cases\)!=\d+', 'len(cases)!='+str(len(keep)),s);s=re.sub(r"\('gpt-6.1-sol','medium',1,\d+\)","('gpt-6.1-sol','medium',1,"+str(len(keep))+")",s)
for key in ['max_model_turns','actor_profiles','independent_questions','completed_actors']:s=re.sub("'"+key+r"':\d+", "'"+key+"':"+str(len(keep)),s)
if (market/'harness/codex/tea-rags/skills/explore/references/local-helpers.md').exists():
    baseline=json.loads(Path('/Users/Shared/nav-ab/graph-continuations-0557-evals/baseline-sealed/harness/shared-manifest.json').read_text())
    expected=sorted([*baseline['plugin_inventory'],'skills/explore/references/local-helpers.md'])
    assert len(expected)==89 and len(set(expected))==89
    s=s.replace("if len(policy)!=88:raise RuntimeError('Expected exact88-file plugin0554')", "if set(policy)!=set("+repr(expected)+"):raise RuntimeError('Plugin0557 paths differ from sealed0556 plus local-helper reference')")
(h/'isolated.py').write_text(s)
t=(template/'test_isolated.py').read_text();t=t.replace("cases=[{'id':q,'prompt':q} for q in ['E01','Q08','Q10']]","cases=[{'id':q,'prompt':q} for q in "+repr(keep)+"]");t=t.replace('len(jobs),3','len(jobs),'+str(len(keep))).replace("len({j['home_key'] for j in jobs}),3","len({j['home_key'] for j in jobs}),"+str(len(keep))).replace("['A','A','A']",repr(['A']*min(4,len(keep)))).replace("'max_model_turns':3","'max_model_turns':"+str(len(keep)));(h/'test_isolated.py').write_text(t)
(h/'evidence/policy-patch.diff').write_text(subprocess.check_output(['git','diff','--','scripts/gen-harness-codex.ts','plugins/tea-rags/skills/explore/SKILL.md'],cwd=wt,text=True))
with (h/'evidence/isolation-tests.txt').open('x') as f:subprocess.run(['/opt/homebrew/bin/python3','-m','unittest','discover','-s',str(h),'-p','test_isolated.py','-v'],stdout=f,stderr=subprocess.STDOUT,check=True)
with (h/'prepare.log').open('x') as f:subprocess.run(['/opt/homebrew/bin/python3',str(h/'isolated.py'),'prepare','--cases',str(base/'cases/cases.json'),'--grading',str(base/'review/grading.json')],cwd=root,stdout=f,stderr=subprocess.STDOUT,check=True)
print(json.dumps({'prepared':str(base),'cases':keep,'model_turns':0}))
