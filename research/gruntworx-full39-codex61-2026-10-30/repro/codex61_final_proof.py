"""Final immutable-home readiness; no model turns."""
import json
import os
from pathlib import Path
import subprocess
import time
from codex61_app_rpc import RPC,CODEX,NODE,REPO
from codex61_runner import BASE,sha,verify_frozen

m=json.loads((BASE/'final-manifest.json').read_text());verify_frozen(m)
version=m['plugin_version']
summary={}
for cell in ['A','B']:
 home=BASE/'proof-homes'/cell;out=BASE/('final-proof-'+cell)
 extra=m['proof_backend_env'][cell]
 rpc=RPC(home,out,extra_env=extra)
 try:
  thread=rpc.call('thread/start',{'cwd':REPO,'model':'gpt-6.1-sol','permissions':'benchmark','approvalPolicy':'never','ephemeral':True})
  (out/'thread-start.json').write_text(json.dumps(thread,indent=2));tid=thread['thread']['id']
  results={}
  for name,method,args in [('skills','skills/list',{'cwds':[REPO],'forceReload':True}),('plugins','plugin/list',{'cwds':[REPO],'forceRefetch':False,'marketplaceKinds':['local']}),('hooks','hooks/list',{'threadId':tid,'cwds':[]}),('mcp','mcpServerStatus/list',{'threadId':tid,'limit':100})]:
   r=rpc.call(method,args);(out/(name+'.json')).write_text(json.dumps(r,ensure_ascii=False,indent=2));results[name]=r
  if cell=='A':
   deadline=time.monotonic()+120
   while any(x.get('runtimeStatus')=='starting' for x in results['mcp']['data']) and time.monotonic()<deadline:
    time.sleep(0.2);results['mcp']=rpc.call('mcpServerStatus/list',{'threadId':tid,'limit':100})
   (out/'mcp.json').write_text(json.dumps(results['mcp'],ensure_ascii=False,indent=2))
  skills=[s for g in results['skills']['data'] for s in g['skills'] if s.get('enabled')]
  hooks=[h for g in results['hooks']['data'] for h in g['hooks']]
  if cell=='A':
   assert skills and all(s.get('pluginId')=='tea-rags@tea-rags' for s in skills)
   assert hooks and all(h['trustStatus']=='trusted' for h in hooks)
   assert all(isinstance(h.get('statusMessage'),str) and h['statusMessage'].strip() for h in hooks),'Hook labels missing'
   assert [x['name'] for x in results['mcp']['data']]==['tea-rags']
   assert results['mcp']['data'][0]['runtimeStatus']=='connected'
  else:
   assert not skills and not hooks and not results['mcp']['data'] and not results['plugins']['marketplaces']
  # Final real config denies production homes and question controller file too.
  paths=[str(BASE/'homes'/cell/'auth.json'),str(BASE/'questions-only.json'),str(BASE/'homes'/('B' if cell=='A' else 'A')/'auth.json')]
  code='import os\npaths='+repr(paths)+'\nfor p in paths:\n try:\n  f=open(p,"rb"); f.read(1); f.close(); print("ALLOWED")\n except OSError as e: print("DENIED",e.errno)'
  py=str(Path('/opt/homebrew/bin/python3').resolve())
  denied=rpc.call('command/exec',{'command':[py,'-c',code],'cwd':REPO,'permissionProfile':'benchmark','timeoutMs':10000})
  assert denied['stdout'].count('DENIED 1')==3
  (out/'production-path-denial.json').write_text(json.dumps(denied,indent=2))
  summary[cell]={'enabled_skills':len(skills),'trusted_hooks':len(hooks),'mcp_servers':len(results['mcp']['data']),
      'instruction_sources':thread['instructionSources'],'active_profile':thread['activePermissionProfile'],
      'backend_argv':[CODEX,'app-server','--stdio','--strict-config'],
      'backend_env_keys':sorted(['PATH','HOME','CODEX_HOME','ASDF_NODEJS_VERSION','LANG',*extra.keys()]),
      'prompts_transport':'JSON-RPC stdin, never argv/environment','auth_transport':'FS-denied auth.json symlink, never env'}
  if cell=='A':
   # Run the actual shipped SessionStart rule hook with a real-shaped event,
   # recording its exact stdout and the core marker/hash it emits.
   hook=next(h for h in hooks if h['eventName']=='sessionStart' and h['command'].endswith('/session-start.sh'))
   env={'PATH':extra['PATH'],'HOME':'/Users/artk0re','CODEX_HOME':str(home),'ASDF_NODEJS_VERSION':'24.15.0',
        'LANG':'en_US.UTF-8',**extra,'PLUGIN_ROOT':str(home/('plugins/cache/tea-rags/tea-rags/'+version))}
   p=subprocess.run(['/bin/sh','-c',hook['command']],cwd=REPO,env=env,
       input=json.dumps({'session_id':'preflight-no-model','cwd':REPO,'hook_event_name':'SessionStart'}),capture_output=True,text=True,timeout=30)
   (out/'actual-rule-hook-stdout.json').write_text(p.stdout)
   assert p.returncode==0 and '# tea-rags core' in p.stdout and '# tea-rags core' in p.stdout
   summary[cell]['shipped_core_sha256']=sha(home/('plugins/cache/tea-rags/tea-rags/'+version+'/scripts/core.txt'))
   summary[cell]['actual_rule_hook_output_sha256']=__import__('hashlib').sha256(p.stdout.encode()).hexdigest()
  env={'PATH':extra.get('PATH',str(Path(NODE).parent)+':/usr/bin:/bin'),'HOME':'/Users/artk0re','CODEX_HOME':str(home),'ASDF_NODEJS_VERSION':'24.15.0','LANG':'en_US.UTF-8',**extra}
  with (out/'prompt-input.json').open('w') as stdout,(out/'prompt-stderr.txt').open('w') as stderr:
   p=subprocess.run([CODEX,'debug','prompt-input','PROBE_NO_MODEL_INFERENCE'],cwd=REPO,env=env,stdout=stdout,stderr=stderr,timeout=180)
  assert p.returncode==0
  print(cell,json.dumps(summary[cell]),flush=True)
 finally:rpc.close()
(BASE/'final-proof-summary.json').write_text(json.dumps(summary,indent=2))
verify_frozen(m)
print('Final immutable A/B preflight passed; zero model turns',flush=True)
