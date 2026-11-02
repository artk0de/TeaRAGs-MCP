"""Native Codex process with same-thread before/after capability gates."""
import importlib.util,json,os,subprocess,time
from pathlib import Path
from policy import READ_TOOLS,check_codex_skills,load,publish,sha,verify_inventory,session_times,hook_union_seconds
P=Path(__file__).resolve().parent

def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def write_config(profile):
 home=Path(profile['codex_home']);home.mkdir(exist_ok=True,parents=True);auth=home/'auth.json'
 if not auth.exists():auth.symlink_to(profile['codex_auth'])
 roots=[profile['guard']['fixture'],profile['guard']['plugin_root'],*profile['minimal_runtime_read_roots']]
 text='model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\ndefault_permissions = "p0_eval"\nallow_login_shell = false\nweb_search = "disabled"\nproject_doc_max_bytes = 0\n'
 text+='\n[features]\n'+''.join(k+' = false\n' for k in ['apps','browser_use','browser_use_external','in_app_browser','computer_use','image_generation','view_image','multi_agent','memories','shell_snapshot','remote_plugin','plugin_sharing','plugin_discovery_prefetch','skill_search','skill_mcp_dependency_install'])+'skip_host_skill_discovery = true\nplugins = true\nhooks = true\n'
 text+='\n[projects.'+json.dumps(profile['guard']['fixture'])+']\ntrust_level = "trusted"\n'
 text+='\n[shell_environment_policy]\ninherit = "none"\nset = { PATH = '+json.dumps(profile['launch_env']['PATH'])+', HOME = "/nonexistent", TMPDIR = "/nonexistent", LANG = "en_US.UTF-8", TEA_RAGS_AUTO_UPDATE = "0" }\n'
 text+='\n[permissions.p0_eval.filesystem]\n":root" = "deny"\n":minimal" = "read"\n":slash_tmp" = "deny"\n":tmpdir" = "deny"\n'+''.join(json.dumps(str(Path(r).resolve()))+' = "read"\n' for r in dict.fromkeys(str(Path(root).resolve()) for root in roots))+'\n[permissions.p0_eval.network]\nenabled = false\n'
 for name in profile['disabled_plugin_ids']:text+='\n[plugins.'+json.dumps(name)+']\nenabled = false\n'
 for rel in profile['disabled_skill_relatives']+[f'skills/.system/{n}/SKILL.md' for n in ['imagegen','openai-docs','review-agent','skill-creator','skill-installer']]:text+='\n[[skills.config]]\npath = '+json.dumps(str(home/rel))+'\nenabled = false\n'
 (home/'config.toml').write_text(text)

def install(profile,out):
 """Authorized metadata phase only; use native installation, never fabricate a cache."""
 home=Path(profile['codex_home']);write_config(profile);env={**profile['launch_env'],'HOME':profile['os_home'],'CODEX_HOME':str(home)};records=[]
 for cmd in [[profile['codex_cli'],'plugin','marketplace','add',profile['marketplace'],'--json'],[profile['codex_cli'],'plugin','add','tea-rags@tea-rags','--json']]:
  proc=subprocess.run(cmd,cwd=profile['guard']['fixture'],env=env,capture_output=True,text=True,timeout=120);records.append({'command':cmd,'returncode':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr})
  if proc.returncode:publish(Path(out)/'native-install-failed.json',records);raise RuntimeError('Native plugin install failed')
 publish(Path(out)/'native-install.json',records);verify_inventory(profile['guard']['plugin_root'],profile['plugin_inventory'])

class CodexNative:
 def __init__(self,profile,out,model_allowed=False):
  self.process_started=time.monotonic();self.user_started=None;self.user_completed=None;self.hook_intervals=[];self.profile=profile;self.out=Path(out);self.out.mkdir(parents=True,exist_ok=False);self.model_allowed=model_allowed;self.turns_sent=0
  guard=module('p0_runtime',P/'validated/controller_io.py');guard.require_controller_python();self.runtime=guard.runtime_identity()
  api=module('p0_rpc',P/'validated/codex61_app_rpc.py');api.REPO=profile['guard']['fixture'];api.CODEX=profile['codex_cli'];api.NODE=profile['node'];api.RG=profile['rg'];native=api.RPC;outer=self
  class RPC(native):
   def send(self,message):
    method=message.get('method')
    if method in ['thread/resume','turn/resume','turn/steer']:raise PermissionError('No resume/steer')
    if method=='turn/start':
     if not model_allowed or outer.turns_sent:raise PermissionError('Exactly one root-authorized question')
     outer.turns_sent+=1
    return super().send(message)
  extra={**profile['launch_env'],'HOME':profile['os_home'],'CODEX_HOME':profile['codex_home'],'TEA_RAGS_AUTO_UPDATE':'0'}
  self.rpc=RPC(profile['codex_home'],self.out,extra_env=extra,allow_model_turns=model_allowed)
  try:
   self.thread=self.rpc.call('thread/start',{'cwd':api.REPO,'model':profile['model'],'permissions':'p0_eval','approvalPolicy':'never','ephemeral':True,'experimentalRawEvents':True});publish(self.out/'thread-start.json',self.thread);self.tid=self.thread['thread']['id']
   if self.thread.get('instructionSources') or self.thread['model']!=profile['model'] or self.thread.get('reasoningEffort')!='medium' or self.thread['activePermissionProfile']['id']!='p0_eval':raise RuntimeError('Unexpected native thread')
  except BaseException:
   try:self.rpc.close()
   except BaseException:pass
   raise

 def trust_hooks(self):
  hooks=self.rpc.call('hooks/list',{'threadId':self.tid,'cwds':[]});publish(self.out/'untrusted-hooks.json',hooks);hs=[h for r in hooks['data'] for h in r['hooks']]
  if len(hs)!=14 or any(h.get('pluginId')!='tea-rags@tea-rags' for h in hs):raise RuntimeError('Unexpected hooks')
  with (Path(self.profile['codex_home'])/'config.toml').open('a') as f:
   for h in hs:f.write('\n[hooks.state.'+json.dumps(h['key'])+']\ntrusted_hash = '+json.dumps(h['currentHash'].split('/sha256:')[0])+'\n')
 def catalog(self,label):
  p=self.profile;verify_inventory(p['guard']['plugin_root'],p['plugin_inventory']);ready=module('p0_ready',P/'validated/mcp_readiness.py').wait_for_mcp_ready(self.rpc,self.tid,READ_TOOLS);skills=self.rpc.call('skills/list',{'cwds':[p['guard']['fixture']],'forceReload':True});rows=[s for r in skills['data'] for s in r['skills']];proof=check_codex_skills(rows,p['guard']['plugin_root'],p['skills']);hooks=self.rpc.call('hooks/list',{'threadId':self.tid,'cwds':[]});hs=[h for r in hooks['data'] for h in r['hooks']];plugins=self.rpc.call('plugin/list',{'cwds':[p['guard']['fixture']],'forceRefetch':False});active=[v for m in plugins.get('marketplaces',[]) for v in m.get('plugins',[]) if v.get('installed') and v.get('enabled')]
  if len(hs)!=14 or any(h.get('trustStatus')!='trusted' or h.get('pluginId')!='tea-rags@tea-rags' for h in hs) or len(active)!=1 or active[0]['id']!='tea-rags@tea-rags':raise RuntimeError('Hook/plugin gate mismatch')
  publish(self.out/(label+'-catalog.json'),{'skills':skills,'hooks':hooks,'plugins_unfiltered':plugins,'mcp_ready':ready,'skill_proof':proof,'plugin_scope_limit':'Native API projection may omit managed catalogs; exact skill provenance gate remains decisive.'});return proof
 def denial_proof(self):
  paths=self.profile['protected_paths'];code='import os\nfor p in '+repr(paths)+':\n try:\n  f=os.open(p,os.O_RDONLY);os.close(f);print("OPEN_ALLOWED")\n except OSError as e:print("OPEN_DENIED",e.errno)';r=self.rpc.call('command/exec',{'command':[self.profile['python'],'-c',code],'cwd':self.profile['guard']['fixture'],'permissionProfile':'p0_eval','timeoutMs':10000});publish(self.out/'open-only-denials.json',r)
  if r['exitCode'] or r['stdout'].count('OPEN_DENIED 1')!=len(paths):raise RuntimeError('Native protected read boundary failed')
 def query(self,prompt):
  if not self.model_allowed:raise PermissionError('No model GO')
  io=module('p0_io',P/'validated/controller_io.py');protocol=module('p0_protocol',P/'validated/protocol.py');journal=io.EventJournal(self.out,'case');start=time.monotonic()
  try:
   self.user_started=time.monotonic();turn=self.rpc.call('turn/start',{'threadId':self.tid,'cwd':self.profile['guard']['fixture'],'permissions':'p0_eval','approvalPolicy':'never','model':self.profile['model'],'effort':'medium','input':[{'type':'text','text':prompt}]});result=protocol.await_turn(self.rpc,turn['turn']['id'],timeout=600,on_event=journal.append);self.user_completed=time.monotonic();events=result.pop('events');requests=result.pop('requests');journal.complete(events);account=protocol.account_events(events);publish(self.out/'accounting.json',account)
   if requests:publish(self.out/'unanswered-requests.json',requests)
   answer='\n\n'.join(e['params']['item']['text'] for e in events if e.get('method')=='item/completed' and (e.get('params',{}).get('item') or {}).get('type')=='agentMessage' and e['params']['item'].get('phase')=='final_answer')
   starts={}
   for e in events:
    if e.get('method')=='hook/started':starts[e['params']['run']['id']]=e['emittedAtMs']/1000
    elif e.get('method')=='hook/completed' and e['params']['run']['id'] in starts:self.hook_intervals.append((starts[e['params']['run']['id']],e['emittedAtMs']/1000))
   hooks=[{'event_index':n,'time_ms':e.get('emittedAtMs'),'run':{k:e['params']['run'].get(k) for k in ['id','eventName','status','durationMs','entries']}} for n,e in enumerate(events) if e.get('method')=='hook/completed'];publish(self.out/'public-hook-context.json',hooks)
   if result.get('status')!='completed' or not account.get('accounting_complete') or not answer:raise RuntimeError('Incomplete actor/accounting; no retry')
   return {'answer':answer,'model_response_count':account['completed_responses'],'accounting':account,'controller_turn_seconds':time.monotonic()-start,'persistence_observation':journal.observations(),'quality':'UNGRADED; no reasoning bodies extracted'}
  except BaseException:
   if not journal.finalized:journal.abort()
   raise
 def close(self):
  self.rpc.close();timing=session_times(self.process_started,self.user_started,self.user_completed,time.monotonic());timing.update(native_hook_union_observed_seconds=hook_union_seconds(self.hook_intervals),native_hook_intervals_epoch_seconds=self.hook_intervals);publish(self.out/'session-times.json',timing)
