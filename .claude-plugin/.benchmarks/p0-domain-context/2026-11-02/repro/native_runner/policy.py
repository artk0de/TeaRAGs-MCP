"""Pure fail-closed targeted-eval policy. No native/model process imports."""
import copy,hashlib,json,os,re
from pathlib import Path
from urllib.parse import unquote
READ_TOOLS={'find_symbol','semantic_search','hybrid_search','search_code','find_similar','rank_chunks','get_callers','get_callees','trace_path','find_cycles','find_co_changed','get_architecture_report','get_naming_lexicon','get_ontology_report','get_index_status','get_index_metrics','list_projects'}
GO_KEYS=['cases_sha256','grading_sha256','profiles_sha256','source_sha256','runtimes_sha256','schedule_sha256','models','efforts','n','actors']
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p):return json.loads(Path(p).read_text())
def publish(path,value):
 p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.writing')
 with tmp.open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n');f.flush()
 try:os.link(tmp,p)
 finally:tmp.unlink()
def stop_check(root):
 if (Path(root)/'STOP.json').exists():raise RuntimeError('Stopped; retain failure and await root audit, no retry')
def authorize(go,seal,key=None):
 if go.get('ROOTGO') is not True:raise PermissionError('Exact root model GO required')
 for k in GO_KEYS:
  if k not in seal or go.get(k)!=seal[k]:raise PermissionError('GO mismatch: '+k)
 if 'selected_keys' in go:
  selected=go['selected_keys']
  if not isinstance(selected,list) or not selected or any(not isinstance(k,str) for k in selected) or len(set(selected))!=len(selected) or go.get('execute_actor_count')!=len(selected) or len(selected)>seal['actors']:raise PermissionError('Invalid selected actor authorization')
  if key is None or key not in selected:raise PermissionError('Selected GO requires an explicitly authorized actor key; run_all forbidden')
 if seal['n']!=1 or seal['actors'] not in [4,8,12,16,20] or seal['models']!={'codex':'gpt-6.1-sol','claude':'claude-sonnet-5-5'}:raise PermissionError('Only bounded targeted actors with chosen models')
def jobs(cases):
 if not 1<=len(cases)<=5 or len({c['id'] for c in cases})!=len(cases) or any(not re.fullmatch(r'[a-zA-Z0-9_-]+',c['id']) for c in cases):raise ValueError('One to five distinct safe case IDs')
 return [{'case_id':c['id'],'variant':v,'harness':h,'key':v+'-'+h+'-'+c['id']} for v in ['baseline','candidate'] for index,c in enumerate(cases) for h in (['codex','claude'] if index%2==0 else ['claude','codex'])]
def case_text(case):
 if not isinstance(case.get('prompt'),str) or not case['prompt']:raise ValueError('One literal prompt required')
 return case['prompt']
def decoded(v):
 old=None;s=str(v)
 for _ in range(4):
  if old==s:break
  old=s;s=unquote(s)
 return s.replace('\\','/')
def allowed_path(value,roots,base,glob=False):
 s=decoded(value)
 if '\x00' in s or '%' in s or '..' in Path(s).parts:return False
 if glob:
  parts=[]
  for part in Path(s).parts:
   if any(c in part for c in '*?['):break
   parts.append(part)
  s=str(Path(*parts)) if parts else '.'
 p=Path(s);p=p if p.is_absolute() else Path(base)/p
 try:return any(p.resolve().is_relative_to(Path(r).resolve()) for r in roots)
 except OSError:return False

def scope_arguments(name,args,cfg):
 if name not in READ_TOOLS or not isinstance(args,dict):raise ValueError('Unknown or mutating tool')
 a=copy.deepcopy(args);fixture=str(Path(cfg['fixture']).resolve())
 for key,wanted in [('project',cfg['project']),('collection',cfg['collection']),('path',fixture)]:
  if key in a and a[key]!=wanted:raise ValueError('Cross-scope '+key)
 if 'collection' in a:raise ValueError('Raw collection addressing disabled')
 a.update(project=cfg['project'],path=fixture)
 if name=='list_projects':a={'project':cfg['project']}
 def walk(v,key=''):
  if isinstance(v,dict):
   for k,x in v.items():
    if k.lower() in ['collection','collectionname','project'] and x not in [cfg['project'],cfg['collection']]:raise ValueError('Nested cross-scope selector')
    walk(x,k)
  elif isinstance(v,list):
   for x in v:walk(x,key)
  elif isinstance(v,str) and (key in ['relativePath','fromPath','toPath','files','filePath','path','pathPattern','affectedFiles'] or (key in ['symbols','symbol','symbolId'] and '/' in v)):
   if not allowed_path(v,[fixture],fixture,key=='pathPattern'):raise ValueError('Outside or traversal locator')
 walk(a)
 return a

def tool_decision(name,args,cfg):
 try:
  if not isinstance(args,dict):raise ValueError('Unknown tool input')
  roots=[cfg['fixture'],cfg['plugin_root']]
  if name in ['ToolSearch','McpToolSearch']:
   q=args.get('query','');refs=re.findall(r'mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+',q)
   if not isinstance(q,str) or not q or not (q in READ_TOOLS or 'tea-rags' in q or 'tea_rags' in q):raise ValueError('Tool discovery must target tea-rags')
   for ref in refs:
    matched=re.fullmatch(r'mcp__tea[-_]rags__([A-Za-z0-9_]+)',ref)
    if not matched or matched[1] not in READ_TOOLS:raise ValueError('Foreign or mutating discovery target')
   if q.startswith('select:') and not refs:raise ValueError('Unknown selected tool')
   return {'allow':True,'metadata_only':True}
  if name in ['Read','Grep','Glob']:
   key='file_path' if name=='Read' else 'path';path=args.get(key)
   if name=='Read' and not isinstance(path,str):raise ValueError('Read path required')
   if path is not None and not allowed_path(path,roots,cfg['fixture']):raise ValueError('Outside readable roots')
   glob=args.get('pattern') if name=='Glob' else args.get('glob')
   if glob and not allowed_path(glob,roots,path or cfg['fixture'],True):raise ValueError('Outside glob')
   return {'allow':True,'path':str(Path(path).resolve()) if path else cfg['fixture']}
  if name=='Skill':
   if args.get('skill') not in cfg['skill_names']:raise ValueError('Unapproved skill')
   return {'allow':True,'skill':args['skill']}
  if name in ['ReadMcpResourceTool','read_mcp_resource']:
   if args.get('server')!='tea-rags' or not safe_resource(args.get('uri',''),cfg):raise ValueError('Unapproved resource')
   return {'allow':True}
  if name in ['ListMcpResourcesTool','list_mcp_resources']:
   if args.get('server')!='tea-rags':raise ValueError('Unapproved server')
   return {'allow':True}
  prefix='mcp__tea-rags__'
  if name.startswith(prefix):scope_arguments(name[len(prefix):],args,cfg);return {'allow':True}
  raise ValueError('Unknown, code-running or mutating tool')
 except (ValueError,KeyError,OSError) as e:return {'allow':False,'reason':str(e)}
def safe_resource(uri,cfg):
 s=decoded(uri)
 return bool('%' not in s and '..' not in s and (re.fullmatch(r'tea-rags://(?:guide|schema)/[a-zA-Z0-9/_-]+',s) or s=='tea-rags://project/'+cfg['project']+'/digest' or s.startswith('tea-rags://project/'+cfg['project']+'/metrics?')))
def check_codex_skills(rows,plugin,expected):
 enabled=[s for s in rows if s.get('enabled')];root=Path(plugin).resolve()
 if len(expected)!=18 or len(enabled)!=18 or {s['name'] for s in enabled}!=set(expected):raise RuntimeError('Exact18 skill set mismatch')
 for s in enabled:
  p=Path(s['path']).resolve();want=expected[s['name']]
  if s.get('pluginId')!='tea-rags@tea-rags' or not p.is_relative_to(root) or str(p.relative_to(root))!=want['relative'] or sha(p)!=want['sha256']:raise RuntimeError('Skill provenance/body fingerprint mismatch')
 return {'enabled':18,'foreign':0,'runtime_body_hashes':True}
def check_claude_catalog(commands,expected):
 foreign=[x['name'] for x in commands if not x.get('builtin') and x['name'] not in expected]
 actual={x['name'] for x in commands if not x.get('builtin')}
 if foreign or actual!=set(expected):raise RuntimeError('Unexpected nonbuiltin command catalog')
 return {'builtin_count':sum(bool(x.get('builtin')) for x in commands),'plugin_commands':sorted(actual),'foreign_nonbuiltin':foreign,'hidden_runtime_hashproof':'UNEXPOSED'}
def validate_claude_frame(frame,model_allowed):
 if frame.get('type')=='user':
  if not model_allowed:raise PermissionError('No user/model frame without root GO')
  return
 if frame.get('type')=='control_response':return
 if frame.get('type')=='control_request' and frame.get('request',{}).get('subtype') in ['initialize','mcp_status','mcp_reconnect']:return
 raise PermissionError('Unsupported control/model frame')
def inventory(root):
 root=Path(root);return {str(p.relative_to(root)):sha(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
def verify_inventory(root,expected):
 if inventory(root)!=expected:raise RuntimeError('Source/plugin/runtime inventory changed')
def expected_skills(root):
 root=Path(root);return {'tea-rags:'+p.parent.name:{'relative':str(p.relative_to(root)),'sha256':sha(p)} for p in (root/'skills').glob('*/SKILL.md')}

def session_times(start,user_start,user_end,end):
 return {'session_total_wall_seconds':end-start,'pre_user_wall_seconds':user_start-start if user_start is not None else None,'user_request_wall_seconds':user_end-user_start if user_start is not None and user_end is not None else None,'post_user_wall_seconds':end-user_end if user_end is not None else None,'limitation':'Session total includes native startup/hooks/control/verification and shutdown. User-only spans are not comparable as complete cross-harness costs.'}


def hook_union_seconds(intervals):
 merged=[]
 for a,b in sorted(intervals):
  if b<a:raise ValueError('Invalid hook interval')
  if merged and a<=merged[-1][1]:merged[-1][1]=max(b,merged[-1][1])
  else:merged.append([a,b])
 return sum(b-a for a,b in merged)

def trusted_backend_env(base,overrides,spec):
 env={**base}
 for k,v in overrides.items():
  if v is None:env.pop(k,None)
  elif isinstance(v,str):env[k]=v
  else:raise ValueError('Trusted env values must be string/null')
 for key,speckey in [('TEA_RAGS_DATA_DIR','backend_data_dir'),('QDRANT_EMBEDDED_STORAGE_PATH','embedded_storage_path')]:
  path=Path(spec[speckey])
  if not path.is_absolute():raise ValueError('Backend state path must be absolute')
  env[key]=str(path)
 env.pop('TRAJECTORY_GIT_ANCHOR',None);env['TEA_RAGS_AUTO_UPDATE']='0'
 return env
