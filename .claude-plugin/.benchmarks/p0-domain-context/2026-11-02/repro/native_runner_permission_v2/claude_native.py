"""Native Claude streaming control, source-bound tool guard, no implicit queries."""
import json,os,queue,subprocess,threading,time
from pathlib import Path
from auth_transport import load_claude_auth
from native_mcp_wait import NativeMcpLogWait,MAX_STARTUP_SECONDS
from policy import (READ_TOOLS,check_claude_catalog,inventory,publish,sha,tool_decision,validate_claude_frame,verify_inventory,session_times,hook_union_seconds)
def validate_native_init(event):
 tools=event.get('tools');servers=event.get('mcp_servers');expected={'mcp__tea-rags__'+name for name in READ_TOOLS}
 if not isinstance(tools,list) or any(not isinstance(name,str) for name in tools):raise RuntimeError('Native MCP init tools missing')
 mcp=[name for name in tools if name.startswith('mcp__')]
 if set(mcp)!=expected or len(mcp)!=len(expected) or not isinstance(servers,list) or len(servers)!=1 or servers[0].get('name')!='tea-rags' or servers[0].get('status')!='connected':raise RuntimeError('Native MCP init must expose exact17 and one connected target')
 return {'source':'ACTUAL_NATIVE_SYSTEM_INIT','mcp_tools':sorted(mcp),'mcp_servers':servers,'validated_before_accepting_output':True,'provider_dispatch_limit':'Controller receipt cannot guarantee cancellation before provider dispatch; native init is yielded before main query body in source.'}

class ClaudeNative:
 def __init__(self,profile,out,model_allowed=False):
  self.process_started=time.monotonic();self.user_started=None;self.user_completed=None;self.closed_at=None;self.received=[];self.profile=profile;self.out=Path(out);self.out.mkdir(parents=True,exist_ok=False);self.model_allowed=model_allowed;self._pre_user_mcp_ready=False;self.counter=0;self.events=[];self.q=queue.Queue();self.guard={**profile['guard']};self.skills=profile['skills'];self.inventory=profile['plugin_inventory']
  cfg=Path(profile['claude_config']);cfg.mkdir(exist_ok=True,parents=True);home=Path(profile['os_home']);home.mkdir(exist_ok=True,parents=True)
  self.mcp_wait=NativeMcpLogWait(profile,started_at=self.process_started)
  env={**profile['launch_env'],**load_claude_auth(),'HOME':str(home),'CLAUDE_CONFIG_DIR':str(cfg),'CLAUDE_PROJECT_DIR':self.guard['fixture'],'CLAUDE_CODE_DISABLE_CLAUDE_MDS':'1','CLAUDE_CODE_DISABLE_AUTO_MEMORY':'1','TEA_RAGS_AUTO_UPDATE':'0','MCP_TIMEOUT':str(MAX_STARTUP_SECONDS*1000)}
  cmd=[profile['claude_cli'],'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-hook-events','--include-partial-messages','--plugin-dir',self.guard['plugin_root'],'--strict-mcp-config','--mcp-config',profile['mcp_config'],'--setting-sources','','--no-session-persistence','--restricted','--tools','Read,Grep,Glob,Skill,ToolSearch,ReadMcpResourceTool,ListMcpResourcesTool','--add-dir',self.guard['plugin_root'],'--allowedTools',','.join('mcp__tea-rags__'+name for name in sorted(READ_TOOLS)),'--permission-mode','dontAsk','--permission-prompts','host','--model',profile['model'],'--effort',profile['effort']]
  publish(self.out/'launch.json',{'command':cmd,'environment_keys':sorted(env),'model_requests_enabled':model_allowed})
  self.raw=(self.out/'events.jsonl').open('x');self.sent=(self.out/'outbound.jsonl').open('x');self.err=(self.out/'stderr.txt').open('x');self.proc=subprocess.Popen(cmd,cwd=self.guard['fixture'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.err,text=True,bufsize=1,start_new_session=True)
  def read():
   for line in self.proc.stdout:
    self.raw.write(line);self.raw.flush()
    try:self.q.put((json.loads(line),time.monotonic()))
    except ValueError:self.q.put(({'type':'invalid_native_json','bytes':len(line)},time.monotonic()))
   self.q.put(({'type':'process_exit','code':self.proc.poll()},time.monotonic()))
  self.thread=threading.Thread(target=read,daemon=True);self.thread.start()
 def send(self,frame):
  validate_claude_frame(frame,self.model_allowed);text=json.dumps(frame,ensure_ascii=False)+'\n';self.sent.write(text);self.sent.flush();self.proc.stdin.write(text);self.proc.stdin.flush()
 def _guard_event(self,e):
  request=e.get('request',{});kind=request.get('subtype');name=None;args={}
  if kind=='hook_callback':
   i=request.get('input',{});name=i.get('tool_name');args=i.get('tool_input',{})
  elif kind=='can_use_tool':name=request.get('tool_name');args=request.get('input',{})
  else:
   self.send({'type':'control_response','response':{'subtype':'error','request_id':e.get('request_id'),'error':'Unsupported evaluation control request'}});return
  decision=tool_decision(name,args,self.guard)
  if decision['allow']:
   verify_inventory(self.guard['plugin_root'],self.inventory)
   if name=='Skill':
    requested=args['skill'];canonical=requested if requested in self.skills else 'tea-rags:'+requested
    if canonical not in self.skills:decision={'allow':False,'reason':'Skill source mapping unavailable'}
    else:
     p=Path(self.guard['plugin_root'])/self.skills[canonical]['relative']
     if sha(p)!=self.skills[canonical]['sha256']:decision={'allow':False,'reason':'Loaded skill path changed'}
     else:decision.update(requested_skill_path=str(p),source_sha256=sha(p),runtime_internal_read='UNEXPOSED; source mapping verified')
  with (self.out/'tool-guard.jsonl').open('a') as f:f.write(json.dumps({'tool':name,'decision':decision,'tool_use_id':request.get('tool_use_id')})+'\n')
  if kind=='hook_callback':
   result={} if decision['allow'] else {'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':decision['reason']}}
  else:result={'behavior':'allow','updatedInput':args} if decision['allow'] else {'behavior':'deny','message':decision['reason']}
  self.send({'type':'control_response','response':{'subtype':'success','request_id':e['request_id'],'response':result}})
 def next(self,timeout):
  while True:
   e,received=self.q.get(timeout=timeout);self.events.append(e);self.received.append((e,received))
   if e.get('type')=='system' and e.get('subtype') in ['hook_started','hook_response']:
    with (self.out/'public-hook-events.jsonl').open('a') as f:f.write(json.dumps({**{k:e.get(k) for k in ['type','subtype','hook_id','hook_name','hook_event','stdout','stderr','exit_code']},'received_monotonic':received},ensure_ascii=False)+'\n')
   if e.get('type')=='control_request':self._guard_event(e);continue
   if e.get('type')=='invalid_native_json':raise RuntimeError('Native CLI emitted invalid JSON')
   return e
 def control(self,payload,timeout=30):
  self.counter+=1;id='p0-control-'+str(self.counter);self.send({'type':'control_request','request_id':id,'request':payload});deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   e=self.next(max(.1,deadline-time.monotonic()))
   if e.get('type')=='process_exit':raise RuntimeError('Native process exited during '+payload['subtype'])
   if e.get('type')=='control_response' and e.get('response',{}).get('request_id')==id:
    r=e['response']
    if r.get('subtype')!='success':raise RuntimeError('Native control failed: '+str(r.get('error')))
    return r.get('response',{})
  raise TimeoutError(payload['subtype'])
 def catalog(self,label):
  verify_inventory(self.guard['plugin_root'],self.inventory)
  info=self.control({'subtype':'initialize','hooks':{'PreToolUse':[{'matcher':'.*','hookCallbackIds':['p0-readonly-guard']}]},'skills':sorted(self.skills)})
  summary=check_claude_catalog(info.get('commands',[]),set(self.profile['public_commands']))
  aliases={a for c in info.get('commands',[]) if c['name'] in self.profile['public_commands'] for a in c.get('aliases',[])};self.guard['skill_names']=list(set(self.guard['skill_names'])|aliases)
  model=next((m for m in info.get('models',[]) if m.get('resolvedModel')==self.profile['model']),None)
  if not model or self.profile['effort'] not in model.get('supportedEffortLevels',[]):raise RuntimeError('Requested Sonnet5.5/effort unavailable; no substitution')
  safe={k:v for k,v in info.items() if k in ['commands','models','capabilities','claude_code_version','session_state']};publish(self.out/(label+'-catalog.json'),{'native':safe,'check':summary,'source_skill_count':len(self.skills),'source_inventory':self.inventory});return summary
 def mcp_ready(self,label):
  if label=='before':
   sessions={e.get('session_id') for e in self.events if e.get('session_id')}
   if len(sessions)!=1:raise RuntimeError('Current native MCP session identity ambiguous')
   terminal=self.mcp_wait.wait_terminal(next(iter(sessions)));publish(self.out/'before-native-mcp-terminal.json',terminal)
  status=self.control({'subtype':'mcp_status'})
  rows=status.get('mcpServers',[])
  if len(rows)!=1 or rows[0].get('name')!='tea-rags':raise RuntimeError('Unexpected MCP servers')
  publish(self.out/(label+'-mcp.json'),status)
  if rows[0].get('status')!='connected':raise RuntimeError('MCP readiness failed; no automatic reconnect/retry')
  tools=rows[0].get('tools')
  names={x['name'] for x in tools} if isinstance(tools,list) else set(tools or {})
  if names!=READ_TOOLS:raise RuntimeError('Connected MCP does not expose exact17 tool metadata')
  if label=='before':self._pre_user_mcp_ready=True
  return {'connected':True,'tools':17}
 def query(self,prompt):
  if not self.model_allowed:raise PermissionError('No model GO')
  if not getattr(self,'_pre_user_mcp_ready',False):raise RuntimeError('Native pre-user MCP terminal gate not satisfied')
  self._pre_user_mcp_ready=False
  self.user_started=time.monotonic();self.send({'type':'user','message':{'role':'user','content':prompt},'parent_tool_use_id':None,'session_id':'default'})
  deadline=time.monotonic()+600;started=time.time_ns();first=None;result=None;native_init_seen=False
  while time.monotonic()<deadline:
   e=self.next(max(.1,deadline-time.monotonic()))
   if e.get('type')=='system' and e.get('subtype')=='init':
    if native_init_seen:raise RuntimeError('Duplicate native MCP init')
    proof=validate_native_init(e);publish(self.out/'native-init-readiness.json',proof);native_init_seen=True
   if e.get('type') in ['assistant','stream_event','result'] and not native_init_seen:raise RuntimeError('Native MCP init missing before output; inference dispatch unknown')
   if e.get('type') in ['assistant','stream_event'] and first is None:first=time.time_ns()
   if e.get('type')=='result':result=e;break
   if e.get('type')=='process_exit':raise RuntimeError('Native actor exited before result')
  if not result:raise TimeoutError('No result; no retry')
  self.user_completed=time.monotonic()
  # Preserve raw stream opaquely; extract only public final text and numeric usage.
  messages={};answer=''
  for e in self.events:
   if e.get('type')=='assistant':
    msg=e.get('message',{});id=msg.get('id')
    if id:messages[id]={k:msg.get(k) for k in ['id','model','usage']}
    text='\n'.join(b.get('text','') for b in msg.get('content',[]) if b.get('type')=='text')
    if text:answer=text
  visible=[(e,t) for e,t in self.received if e.get('type')=='stream_event' and e.get('event',{}).get('type')=='content_block_delta' and e.get('event',{}).get('delta',{}).get('type')=='text_delta'];visible_times=[t for e,t in visible];visible_bytes=sum(len(e['event']['delta'].get('text','').encode()) for e,t in visible)
  if any(v.get('model') and not (v['model']==self.profile['model'] or v['model'].startswith(self.profile['model']+'-')) for v in messages.values()):raise RuntimeError('Unexpected served model; no substitution')
  if result.get('is_error'):raise RuntimeError('Native result error; retained, no retry')
  return {'answer':result.get('result',answer),'unique_model_responses':list(messages.values()),'model_response_count':len(messages),'native_usage':result.get('usage'),'first_observed_output_delay_seconds':(first-started)/1e9 if first else None,'visible_delta_bytes':visible_bytes,'first_visible_text_TTFT_seconds':visible_times[0]-self.user_started if visible_times else None,'observed_text_stream_seconds':visible_times[-1]-visible_times[0] if len(visible_times)>1 else None,'timing_limit':'Text-delta client receipt intervals, not provider decode time; all startup hooks remain in sessiontotal.','quality':'UNGRADED; controller-only grading','native_result_type':result.get('subtype')}
 def close(self):
  try:self.proc.stdin.close();self.proc.wait(timeout=10)
  except (subprocess.TimeoutExpired,BrokenPipeError):self.proc.terminate();self.proc.wait(timeout=10)
  self.thread.join(timeout=5);self.raw.close();self.sent.close();self.err.close();self.closed_at=time.monotonic();timing=session_times(self.process_started,self.user_started,self.user_completed,self.closed_at);starts={};intervals=[]
  for e,t in self.received:
   if e.get('type')=='system' and e.get('subtype')=='hook_started':starts[e.get('hook_id')]=t
   elif e.get('type')=='system' and e.get('subtype')=='hook_response' and e.get('hook_id') in starts:intervals.append((starts[e['hook_id']],t))
  timing.update(native_hook_union_observed_seconds=hook_union_seconds(intervals),native_hook_intervals_monotonic=intervals,hook_clock='Client receipt notifications, not provider inference time');publish(self.out/'session-times.json',timing)
