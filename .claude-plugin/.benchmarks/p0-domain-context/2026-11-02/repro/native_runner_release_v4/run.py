#!/opt/homebrew/bin/python3
"""Separate domain/freshness native actor controller. Static prepare never launches a CLI.

Native prove needs explicit metadata GO; model run needs separately sealed root GO.
No production edits, synthetic prime, preloaded workflow, retry, resume or old72use.
"""
import argparse,hashlib,json,os,shlex,shutil,sys,time
from pathlib import Path
from policy import (GO_KEYS,authorize,case_text,expected_skills,inventory,jobs,load,publish,sha,stop_check,verify_inventory,trusted_backend_env)
from codex_native import CodexNative,install,module
from claude_native import ClaudeNative
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent))
from variant_plugins import select_plugin

def selected_plugin(spec,job):return select_plugin(spec,job['variant'],job['harness'])

def select_schedule(all_jobs,case_ids):
 if not isinstance(case_ids,list) or not case_ids or len(case_ids)!=len(set(case_ids)) or set(case_ids)-{j['case_id'] for j in all_jobs}:raise ValueError('Explicit distinct existing selected case IDs required')
 return [j for j in all_jobs if j['case_id'] in case_ids]

def replay_delivery_status(case_id,path):
 if case_id not in ['F01','F02']:return {'status':'NOT_APPLICABLE'}
 rows=[json.loads(x) for x in Path(path).read_text().splitlines()] if Path(path).is_file() else []
 status='FAIL_UNEXERCISED' if any(r.get('status')=='unexercised' for r in rows) else ('EXERCISED_UNGRADED' if any(r.get('status')=='applied' for r in rows) else 'FAIL_NOT_EXERCISED')
 return {'status':status,'audit_count':len(rows),'audit_sha256':sha(path) if Path(path).is_file() else None,'limits':'Eligibility only; answer quality requires separate controller grading. Unexercised attempts remain failures.'}


def file_inventory(root):
 root=Path(root);return {str(p):sha(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
def verify_files(expected):
 for path,digest in expected.items():
  if sha(path)!=digest:raise RuntimeError('Frozen file changed: '+path)
def source_files():
 files=[p for p in P.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix in ['.py','.json','.cjs','.sh']]
 files += [P.parent/name for name in ['replay_transform.py','variant_plugins.py']]
 return {str(p):sha(p) for p in files}
def runtime_files(root):
 root=Path(root);paths=file_inventory(root/'build')
 for name in ['package.json','.qdrant-required-version']:
  if not (root/name).is_file():raise RuntimeError('Runtime asset missing: '+str(root/name))
  paths[str(root/name)]=sha(root/name)
 if not (root/'build/cli/index.js').is_file():raise RuntimeError('No real CLI entry')
 return paths

def prepare(spec_path,out):
 spec=load(spec_path);out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False);os.umask(0o077)
 guard=module('runtime_guard',P/'validated/controller_io.py');runtime=guard.require_controller_python();cases_path=Path(spec['cases_path']).resolve();grading=Path(spec['grading_path']).resolve();cases=load(cases_path)['cases'];schedule=select_schedule(jobs(cases),spec['selected_case_ids']);fixture=str(Path(spec['fixture']).resolve())
 for p in [cases_path,grading,Path(spec_path).resolve()]:
  if p.is_relative_to(fixture):raise RuntimeError('Controller cases/grading/spec must be outside fixture')
 if spec['models']!={'codex':'gpt-6.1-sol','claude':'claude-sonnet-5-5'}:raise RuntimeError('Chosen exact models required')
 for variant in ['baseline','candidate']:
  for harness,count in [('codex',18),('claude',17)]:
   selected=selected_plugin(spec,{'variant':variant,'harness':harness})
   if selected['version']!=spec['variant_plugin_versions'][variant][harness] or len(expected_skills(selected['root']))!=count:raise RuntimeError('Explicit manifest-bound variant versions and18/17 source manifests required')
 runtimes={k:runtime_files(v) for k,v in spec['runtime_roots'].items()}
 for files in runtimes.values():
  files.update({str(Path(spec[k]).resolve()):sha(Path(spec[k]).resolve()) for k in ['node','codex_cli','claude_cli','rg']})
 if set(runtimes)!= {'baseline','candidate'}:raise RuntimeError('Exactly baseline and candidate')
 base_env=load(spec['upstream_env_path']);base_env=base_env.get('upstream_env',base_env);base_env.pop('TRAJECTORY_GIT_ANCHOR',None);base_env['TEA_RAGS_AUTO_UPDATE']='0';profiles={};source=source_files();fixture_inventory=inventory(fixture)
 for job in schedule:
  q=next(c for c in cases if c['id']==job['case_id']);case_text(q);p=out/'profiles'/job['key'];p.mkdir(parents=True);(p/'private').mkdir();os_home=p/'os-home';os_home.mkdir();node=spec['node'];python=runtime['executable'];runtime_root=Path(spec['runtime_roots'][job['variant']]).resolve();env={**base_env}
  overrides=spec['case_env_overrides'].get(job['case_id'])
  if not isinstance(overrides,dict):raise RuntimeError('Trusted per-case env map required')
  for k,v in overrides.items():
   if v is None:env.pop(k,None)
   elif isinstance(v,str):env[k]=v
   else:raise RuntimeError('Environment values must be string or null')
  env=trusted_backend_env(base_env,overrides,spec);env['PATH']=str(Path(node).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  proxy={'fixture':fixture,'project':spec['project'],'collection':spec['collection'],'upstream_env':env,'upstream_command':[node,str(runtime_root/'build/cli/index.js'),'server'],'audit_log':str(p/'proxy-audit.jsonl'),'forensic_dir':str(p/'private/forensic'),'upstream_stderr_log':str(p/'private/upstream-stderr.txt'),'diagnostic_fetch':bool(spec.get('diagnostic_fetch',False))}
  if job['case_id'] in ['F01','F02']:proxy['replay']={'actor_id':job['key'],'case_id':job['case_id'],'audit_log':str(p/'replay-audit.jsonl'),'helper_sha256':sha(P.parent/'replay_transform.py')}
  publish(p/'proxy.json',proxy)
  bin=p/'bin';bin.mkdir();(bin/'tea-rags').write_text('#!/bin/sh\nexport BENCH_MCP_PROXY_CONFIG='+shlex.quote(str(p/'proxy.json'))+'\nexport TEA_RAGS_AUTO_UPDATE=0\nexec '+shlex.quote(python)+' '+shlex.quote(str(P/'runtime_cli.py'))+' "$@"\n');(bin/'tea-rags').chmod(0o755)
  selection=selected_plugin(spec,job);original=Path(selection['root']).resolve();version=selection['version']
  if job['harness']=='codex':
   marketplace=p/'marketplace';target=marketplace/'harness/codex/tea-rags';target.parent.mkdir(parents=True);shutil.copytree(original,target);(marketplace/'.agents/plugins').mkdir(parents=True);publish(marketplace/'.agents/plugins/marketplace.json',{'name':'tea-rags','interface':{'displayName':'tea-rags'},'plugins':[{'name':'tea-rags','source':{'source':'local','path':'./harness/codex/tea-rags'},'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'},'category':'Developer Tools'}]});plugin=p/'codex-home/plugins/cache/tea-rags/tea-rags'/version
  else:
   plugin=p/'active-plugin';shutil.copytree(original,plugin);marketplace=None
  sk=expected_skills(original);public=[]
  if job['harness']=='claude':
   for name,info in sk.items():
    if 'user-invocable: false' not in (original/info['relative']).read_text():public.append(name)
   public+=['tea-rags:'+f.stem for f in (original/'commands').glob('*.md')]
  launch={'PATH':str(bin)+':'+env['PATH'],'LANG':'en_US.UTF-8','ASDF_NODEJS_VERSION':'24.15.0','TEA_RAGS_AUTO_UPDATE':'0','TEA_RAGS_PACKAGE_ROOT':str(runtime_root),'TEA_RAGS_HOOK_STATE_DIR':str(p/'hook-state'),'BENCH_MCP_PROXY_CONFIG':str(p/'proxy.json')}
  mcp={'mcpServers':{'tea-rags':{'command':python,'args':[str(P/'scoped_proxy.py')],'env':{'BENCH_MCP_PROXY_CONFIG':str(p/'proxy.json'),'TEA_RAGS_AUTO_UPDATE':'0'}}}};publish(p/'mcp.json',mcp)
  pyframework=next(x for x in Path(python).parents if x.name=='Python.framework');roots=[python,str(pyframework),spec['codex_cli'],node,spec['rg'],str(Path(spec['rg']).resolve()),'/opt/homebrew/opt/pcre2',str(Path('/opt/homebrew/opt/pcre2').resolve())]
  profile={'job':job,'guard':{'fixture':fixture,'project':spec['project'],'collection':spec['collection'],'plugin_root':str(plugin),'skill_names':sorted(sk)},'plugin_selection':selection,'plugin_inventory':inventory(original),'plugin_source_root':str(original),'skills':sk,'public_commands':public,'model':spec['models'][job['harness']],'effort':spec['efforts'][job['harness']],'launch_env':launch,'python':python,'node':node,'rg':spec['rg'],'codex_cli':spec['codex_cli'],'claude_cli':spec['claude_cli'],'codex_auth':spec['codex_auth'],'codex_home':str(p/'codex-home'),'claude_config':str(p/'claude-config'),'os_home':str(os_home),'marketplace':str(marketplace) if marketplace else None,'mcp_config':str(p/'mcp.json'),'minimal_runtime_read_roots':roots,'disabled_plugin_ids':spec['disabled_plugin_ids'],'disabled_skill_relatives':spec['disabled_skill_relatives'],'protected_paths':[str(P/'run.py'),str(cases_path),str(grading),str(p/'proxy.json'),str(p/'profile.json'),spec['codex_auth']],'proxy_sha256':sha(p/'proxy.json'),'mcp_sha256':sha(p/'mcp.json')}
  publish(p/'profile.json',profile);profiles[job['key']]=sha(p/'profile.json')
 publish(out/'profiles.json',profiles);publish(out/'schedule.json',schedule);publish(out/'runtimes.json',runtimes);publish(out/'source.json',source)
 seal={'cases_sha256':sha(cases_path),'grading_sha256':sha(grading),'profiles_sha256':sha(out/'profiles.json'),'source_sha256':sha(out/'source.json'),'runtimes_sha256':sha(out/'runtimes.json'),'schedule_sha256':sha(out/'schedule.json'),'models':spec['models'],'efforts':spec['efforts'],'n':1,'actors':len(schedule),'spec_sha256':sha(spec_path),'fixture':fixture,'fixture_inventory':fixture_inventory,'cases_path':str(cases_path),'grading_path':str(grading),'runtime_identity':runtime,'spec_path':str(Path(spec_path).resolve()),'status':'STATIC_PREPARED; nativeproofs/modelGO required'};publish(out/'seal.json',seal);publish(out/'ROOTGO-template.json',{k:seal[k] for k in GO_KEYS}|{'ROOTGO':False});return seal

def checked_schedule(out,seal):
 out=Path(out);schedule=load(out/'schedule.json');expected=jobs(load(seal['cases_path'])['cases'])
 if 'spec_path' in seal:expected=select_schedule(expected,load(seal['spec_path'])['selected_case_ids'])
 if sha(out/'schedule.json')!=seal['schedule_sha256'] or schedule!=expected:raise RuntimeError('Frozen exact selected schedule changed')
 return schedule

def validate(out,key):
 out=Path(out).resolve();seal=load(out/'seal.json');guard=module('runtime_guard',P/'validated/controller_io.py');guard.verify_runtime(seal['runtime_identity']);checked_schedule(out,seal);verify_files(load(out/'source.json'))
 for v in load(out/'runtimes.json').values():verify_files(v)
 if sha(seal['cases_path'])!=seal['cases_sha256'] or sha(seal['grading_path'])!=seal['grading_sha256'] or sha(seal['spec_path'])!=seal['spec_sha256']:raise RuntimeError('Cases/grading/spec changed')
 if sha(out/'profiles.json')!=seal['profiles_sha256'] or sha(out/'source.json')!=seal['source_sha256'] or sha(out/'runtimes.json')!=seal['runtimes_sha256']:raise RuntimeError('Seal changed')
 verify_inventory(seal['fixture'],seal['fixture_inventory']);profiles=load(out/'profiles.json');path=out/'profiles'/key/'profile.json'
 if sha(path)!=profiles[key]:raise RuntimeError('Profile changed')
 p=load(path)
 if sha(Path(p['mcp_config']).parent/'proxy.json')!=p['proxy_sha256'] or sha(p['mcp_config'])!=p['mcp_sha256']:raise RuntimeError('Transport config changed')
 verify_inventory(p['plugin_source_root'],p['plugin_inventory']);return seal,p

def prove(out,key,native_go):
 out=Path(out).resolve();seal,p=validate(out,key);go=load(native_go)
 if go.get('ROOT_NATIVE_GO') is not True or key not in go.get('keys',[]) or go.get('seal_sha256')!=sha(out/'seal.json'):raise PermissionError('Exact metadata-only GO required')
 result=out/'proofs'/key;result.mkdir(parents=True,exist_ok=False);client=None
 try:
  if p['job']['harness']=='codex':
   install(p,result);trust=CodexNative(p,result/'trust',False)
   try:trust.trust_hooks()
   finally:trust.close()
   client=CodexNative(p,result/'native',False);before=client.catalog('before');client.denial_proof();after=client.catalog('after')
  else:
   client=ClaudeNative(p,result/'native',False);before=client.catalog('before');client.mcp_ready('before');after=client.catalog('after');client.mcp_ready('after')
  record={'status':'ready','model_turns':0,'before':before,'after':after,'profile_sha256':sha(out/'profiles'/key/'profile.json'),'limits':'Claude hidden7 runtime body hashes remain UNEXPOSED; source hashes and loaded-path guards enforced. Hook failures/pending faithfully retained.'};publish(result/'result.json',record);return record
 except BaseException as e:publish(result/'failure.json',{'status':'failed_or_pending','error':str(e),'model_turns':0,'retry':False});raise
 finally:
  if client:client.close()

def run_one(out,key,go_path):
 out=Path(out).resolve();stop_check(out);seal,p=validate(out,key);authorize(load(go_path),seal,key);proof=load(out/'proofs'/key/'result.json')
 if proof.get('status')!='ready':raise RuntimeError('Native proof not ready')
 if load(Path(p['mcp_config']).parent/'proxy.json').get('diagnostic_fetch'):raise RuntimeError('Diagnostic fetch observer forbidden in actual model actors')
 job=out/'actors'/key;job.mkdir(parents=True,exist_ok=False);client=None
 try:
  if p['job']['harness']=='codex':
   if not Path(p['codex_home']).is_dir():raise RuntimeError('No proved native home')
   client=CodexNative(p,job/'native',True)
  else:client=ClaudeNative(p,job/'native',True)
  before=client.catalog('before')
  if p['job']['harness']=='claude':client.mcp_ready('before')
  case=next(c for c in load(seal['cases_path'])['cases'] if c['id']==p['job']['case_id']);answer=client.query(case_text(case));publish(job/'answer-and-accounting.json',answer)
  after=client.catalog('after')
  if p['job']['harness']=='claude':client.mcp_ready('after')
  verify_inventory(p['guard']['plugin_root'],p['plugin_inventory']);delivery=replay_delivery_status(p['job']['case_id'],Path(p['mcp_config']).parent/'replay-audit.jsonl');publish(job/'replay-delivery.json',delivery);publish(job/'result.json',{'status':'completed','before':before,'after':after,'quality':'UNGRADED','replay_delivery':delivery,'model_response_count':answer['model_response_count'],'rootgo_sha256':sha(go_path)})
 except BaseException as e:
  failure={'key':key,'status':'failed','error':str(e),'retry':False};publish(job/'failure.json',failure)
  if not (out/'STOP.json').exists():publish(out/'STOP.json',failure)
  raise
 finally:
  if client:client.close()

def run_all(out,go):
 out=Path(out).resolve();seal=load(out/'seal.json');authorize(load(go),seal);schedule=checked_schedule(out,seal);stop_check(out);publish(out/'RUN-STARTED.json',{'rootgo_sha256':sha(go),'time_ns':time.time_ns(),'actors':len(schedule),'concurrency':1})
 completed=[]
 for job in schedule:
  run_one(out,job['key'],go);completed.append(job['key'])
 publish(out/'RUN-COMPLETED.json',{'actors':len(completed),'completed_keys':completed,'quality':'UNGRADED'})

if __name__=='__main__':
 a=argparse.ArgumentParser();s=a.add_subparsers(dest='action',required=True);p=s.add_parser('prepare');p.add_argument('--spec',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p=s.add_parser('prove');p.add_argument('--out',type=Path,required=True);p.add_argument('--key',required=True);p.add_argument('--native-go',type=Path,required=True);p=s.add_parser('run');p.add_argument('--out',type=Path,required=True);p.add_argument('--rootgo',type=Path,required=True);args=a.parse_args()
 if args.action=='prepare':print(json.dumps(prepare(args.spec,args.out),indent=2))
 elif args.action=='prove':print(json.dumps(prove(args.out,args.key,args.native_go),indent=2))
 else:run_all(args.out,args.rootgo)
