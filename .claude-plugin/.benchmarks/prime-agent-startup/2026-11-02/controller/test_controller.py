"""Focused model-free boundary and authorization tests; never starts a CLI."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
P=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('policy',P/'policy.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class PolicyTests(unittest.TestCase):
 def need(self,name):self.assertTrue(hasattr(m,name),'missing safety behavior '+name)
 def test_scope_rejects_cross_project_collection_and_writes(self):
  self.need('scope_arguments')
  with tempfile.TemporaryDirectory() as d:
   cfg={'fixture':d,'project':'fixture','collection':'code_fixture'}
   self.assertEqual(m.scope_arguments('semantic_search',{'query':'x'},cfg)['path'],str(Path(d).resolve()))
   for name,args in [('index_codebase',{}),('semantic_search',{'project':'other'}),('find_symbol',{'relativePath':'../gold'}),('find_symbol',{'relativePath':'%2e%2e/gold'}),('find_symbol',{'collection':'other'})]:
    with self.subTest(name=name,args=args),self.assertRaises(ValueError):m.scope_arguments(name,args,cfg)
 def test_claude_guard_denies_unknown_outside_write_and_symlink(self):
  self.need('tool_decision')
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);fixture=root/'fixture';plugin=root/'plugin';fixture.mkdir();plugin.mkdir();outside=root/'gold';outside.write_text('private');(fixture/'escape').symlink_to(outside);cfg={'fixture':str(fixture),'project':'fixture','collection':'code_fixture','plugin_root':str(plugin),'skill_names':['tea-rags:explore']}
   self.assertTrue(m.tool_decision('Read',{'file_path':str(fixture/'source.rb')},cfg)['allow'])
   for name,args in [('Read',{'file_path':str(outside)}),('Read',{'file_path':str(fixture/'escape')}),('Write',{'file_path':str(fixture/'x')}),('Bash',{'command':'cat x'}),('Unknown',{}),('Skill',{'skill':'foreign:skill'}),('Grep',{'path':str(outside),'pattern':'x'})]:self.assertFalse(m.tool_decision(name,args,cfg)['allow'],(name,args))
 def test_exact_skill_provenance_and_hash_not_count_only(self):
  self.need('check_codex_skills')
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);expected={};rows=[]
   for n in range(18):
    f=p/'skills'/str(n)/'SKILL.md';f.parent.mkdir(parents=True);f.write_text(str(n));name='tea-rags:'+str(n);expected[name]={'relative':str(f.relative_to(p)),'sha256':m.sha(f)};rows.append({'name':name,'path':str(f),'pluginId':'tea-rags@tea-rags','enabled':True})
   m.check_codex_skills(rows,p,expected)
   bad=[dict(x) for x in rows];bad[0]['pluginId']='foreign@remote'
   with self.assertRaises(RuntimeError):m.check_codex_skills(bad,p,expected)
   Path(rows[0]['path']).write_text('changed')
   with self.assertRaises(RuntimeError):m.check_codex_skills(rows,p,expected)
 def test_go_binds_models_cases_grading_runtime_source_and_count(self):
  self.need('authorize')
  seal={k:k for k in ['cases_sha256','grading_sha256','profiles_sha256','source_sha256','runtimes_sha256','schedule_sha256']};seal.update(models={'codex':'gpt-6.1-sol','claude':'claude-sonnet-5-5'},efforts={'codex':'medium','claude':'medium'},n=1,actors=8)
  go={**seal,'ROOTGO':True};m.authorize(go,seal)
  for k in seal:
   with self.subTest(k=k),self.assertRaises(PermissionError):m.authorize({**go,k:'wrong'},seal)
  with self.assertRaises(PermissionError):m.authorize({**go,'ROOTGO':False},seal)
 def test_fresh_unique_schedule_and_single_case_input(self):
  self.need('jobs');self.need('case_text')
  cases=[{'id':'startup','prompt':'only startup'},{'id':'config','prompt':'only config'}];jobs=m.jobs(cases);self.assertEqual(len(jobs),8);self.assertEqual(len({j['key'] for j in jobs}),8);self.assertEqual(m.case_text(cases[0]),'only startup');self.assertNotIn('config',m.case_text(cases[0]))
 def test_atomic_result_never_overwrites_and_failure_blocks(self):
  self.need('publish');self.need('stop_check')
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);m.publish(p/'result.json',{'status':'complete'})
   with self.assertRaises(FileExistsError):m.publish(p/'result.json',{})
   m.publish(p/'STOP.json',{'failure':'retained'})
   with self.assertRaises(RuntimeError):m.stop_check(p)
 def test_claude_command_menu_separates_builtin_and_hidden_limits(self):
  self.need('check_claude_catalog');commands=[{'name':'native','builtin':True},{'name':'tea-rags:explore'},{'name':'tea-rags:prime'}];x=m.check_claude_catalog(commands,{'tea-rags:explore','tea-rags:prime'});self.assertEqual(x['builtin_count'],1);self.assertEqual(x['foreign_nonbuiltin'],[]);self.assertEqual(x['hidden_runtime_hashproof'],'UNEXPOSED')
  with self.assertRaises(RuntimeError):m.check_claude_catalog(commands+[{'name':'foreign:skill'}],{'tea-rags:explore','tea-rags:prime'})
 def test_claude_control_cannot_send_user_without_root_gate(self):
  self.need('validate_claude_frame')
  m.validate_claude_frame({'type':'control_request','request':{'subtype':'initialize'}},False)
  for frame in [{'type':'user','message':{'content':'prompt'}},{'type':'control_request','request':{'subtype':'unknown'}}]:
   with self.assertRaises(PermissionError):m.validate_claude_frame(frame,False)

class ProtocolTests(unittest.TestCase):
 def test_terminal_success_then_one_mcp_snapshot_no_reconnect(self):
  import claude_native
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as d:
   calls=[]
   def wait(sid):calls.append('terminal');return {'status':'connected'}
   def control(payload,**kwargs):calls.append(payload['subtype']);return {'mcpServers':[{'name':'tea-rags','status':'connected','tools':[{'name':name} for name in m.READ_TOOLS]}]}
   obj=SimpleNamespace(out=Path(d),control=control,events=[{'session_id':'current'}],mcp_wait=SimpleNamespace(wait_terminal=wait));claude_native.ClaudeNative.mcp_ready(obj,'before');self.assertEqual(calls,['terminal','mcp_status'])
 def test_failed_terminal_stops_before_any_user_or_status_request(self):
  import claude_native
  from types import SimpleNamespace
  from unittest.mock import Mock
  with tempfile.TemporaryDirectory() as d:
   control=Mock();send=Mock();obj=SimpleNamespace(out=Path(d),control=control,send=send,events=[{'session_id':'current'}],mcp_wait=SimpleNamespace(wait_terminal=Mock(side_effect=RuntimeError('Native MCP terminal failure'))))
   with self.assertRaisesRegex(RuntimeError,'terminal failure'):claude_native.ClaudeNative.mcp_ready(obj,'before')
   control.assert_not_called();send.assert_not_called()
 def test_query_without_preuser_terminal_gate_cannot_send_user(self):
  import claude_native
  from unittest.mock import Mock
  obj=claude_native.ClaudeNative.__new__(claude_native.ClaudeNative);obj.model_allowed=True;obj.send=Mock()
  with self.assertRaisesRegex(RuntimeError,'pre-user'):obj.query('literal fixture prompt')
  obj.send.assert_not_called()
 def test_sdk_pretool_guard_denies_even_if_native_permission_would_allow(self):
  import claude_native
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);fixture=root/'fixture';plugin=root/'plugin';fixture.mkdir();plugin.mkdir();sent=[];obj=SimpleNamespace(guard={'fixture':str(fixture),'plugin_root':str(plugin),'skill_names':[]},out=root,send=sent.append)
   event={'request_id':'guard-1','request':{'subtype':'hook_callback','input':{'tool_name':'Read','tool_input':{'file_path':str(root/'gold.json')}}}}
   claude_native.ClaudeNative._guard_event(obj,event);output=sent[0]['response']['response']['hookSpecificOutput'];self.assertEqual(output['permissionDecision'],'deny')
 def test_real_cli_keeps_case_env_and_rejects_write_command(self):
  import runtime_cli
  from types import SimpleNamespace
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   d=str(Path(d).resolve());cfg={'fixture':d,'upstream_env':{'QDRANT_URL':'embedded','TEA_RAGS_AUTO_UPDATE':'0'},'upstream_command':['node','real/cli.js','server'],'upstream_stderr_log':str(Path(d)/'private.stderr')};seen=[]
   def execute(command,**kwargs):seen.append((command,kwargs));return SimpleNamespace(returncode=0,stdout='actual upstream bytes')
   with patch.object(runtime_cli,'configured',return_value=(cfg,SimpleNamespace())),patch.object(runtime_cli.subprocess,'run',side_effect=execute),patch.object(runtime_cli.sys,'argv',['cli','prime','--agent',d]):self.assertEqual(runtime_cli.main(),0)
   self.assertEqual(seen[0][0],['node','real/cli.js','prime','--agent',d]);self.assertEqual(seen[0][1]['env']['QDRANT_URL'],'embedded');self.assertEqual(seen[0][1]['env']['TEA_RAGS_AUTO_UPDATE'],'0')
   with patch.object(runtime_cli,'configured',return_value=(cfg,SimpleNamespace())),patch.object(runtime_cli.sys,'argv',['cli','index-codebase',d]),self.assertRaises(SystemExit):runtime_cli.main()

class ReviewFidelityTests(unittest.TestCase):
 def test_shipped_readonly_cli_forms_forward_without_shell_and_scope_outlines(self):
  import runtime_cli
  from unittest.mock import patch
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as d:
   root=str(Path(d).resolve());cfg={'fixture':root,'project':'fixture','collection':'code_fixture','upstream_env':{'TEA_RAGS_AUTO_UPDATE':'0'},'upstream_command':['node','real.js','server'],'upstream_stderr_log':str(Path(root)/'stderr')};seen=[]
   proxy=SimpleNamespace(safe_path=lambda x:m.allowed_path(x,[root],root),guard_call=lambda n,a:m.scope_arguments(n,a,cfg),parse_tool_text=lambda text,n,a:text)
   def execute(argv,**kw):seen.append((argv,kw));return SimpleNamespace(returncode=0,stdout='{"results":[]}')
   forms=[['project','indexed','--command','cat source.rb; echo $(touch never)','--cwd',root,'--json'],['call','find_symbol',json.dumps({'path':root,'symbols':['source.rb'],'metaOnly':True}),'--format','json']]
   for args in forms:
    with patch.object(runtime_cli,'configured',return_value=(cfg,proxy)),patch.object(runtime_cli.subprocess,'run',side_effect=execute),patch.object(runtime_cli.sys,'argv',['cli']+args):self.assertEqual(runtime_cli.main(),0)
    self.assertNotIn('shell',seen[-1][1])
   forwarded=json.loads(seen[-1][0][4]);self.assertEqual(forwarded['project'],'fixture');self.assertEqual(forwarded['path'],root)
   bad=[['project','indexed','--command','cat x','--cwd','/outside','--json'],['call','find_symbol',json.dumps({'symbols':['../gold']}),'--format','json'],['call','index_codebase','{}','--format','json']]
   for args in bad:
    with patch.object(runtime_cli,'configured',return_value=(cfg,proxy)),patch.object(runtime_cli.subprocess,'run',side_effect=AssertionError('must not launch')),patch.object(runtime_cli.sys,'argv',['cli']+args),self.assertRaises((SystemExit,ValueError)):runtime_cli.main()
 def test_schedule_tamper_rejected_before_run_marker_and_genuine_eight_counted(self):
  import run
  from unittest.mock import patch
  cases=[{'id':'C01','prompt':'one'},{'id':'C02','prompt':'two'}];expected=m.jobs(cases)
  self.assertIn('schedule_sha256',m.GO_KEYS)
  for schedule in [[],expected[:-1],list(reversed(expected)),expected[:-1]+[expected[0]],expected]:
   with tempfile.TemporaryDirectory() as d:
    root=Path(d);m.publish(root/'cases.json',{'cases':cases});m.publish(root/'schedule.json',schedule);m.publish(root/'seal.json',{'cases_path':str(root/'cases.json'),'schedule_sha256':m.sha(root/'schedule.json')});m.publish(root/'go.json',{});calls=[]
    with patch.object(run,'authorize'),patch.object(run,'run_one',side_effect=lambda out,key,go:calls.append(key)):
     if schedule!=expected:
      with self.assertRaises(RuntimeError):run.run_all(root,root/'go.json')
      self.assertFalse((root/'RUN-STARTED.json').exists());self.assertEqual(calls,[])
     else:
      run.run_all(root,root/'go.json');self.assertEqual(len(calls),8);self.assertEqual(m.load(root/'RUN-COMPLETED.json')['actors'],len(calls))

class ConstructorCleanupTests(unittest.TestCase):
 def test_rpc_initialize_failure_terminates_child_and_closes_journals(self):
  import codex_native
  from unittest.mock import patch,MagicMock
  rpc=codex_native.module('cleanup_rpc',P/'validated/codex61_app_rpc.py')
  with tempfile.TemporaryDirectory() as d:
   opened=[];original=Path.open
   def tracked(path,*args,**kwargs):
    f=original(path,*args,**kwargs);opened.append(f);return f
   child=MagicMock();child.stdout=[]
   with patch.object(rpc.subprocess,'Popen',return_value=child),patch.object(rpc.threading,'Thread'),patch.object(rpc.RPC,'call',side_effect=RuntimeError('initialize failed')),patch.object(Path,'open',tracked):
    with self.assertRaisesRegex(RuntimeError,'initialize failed'):rpc.RPC(d,d)
   child.terminate.assert_called_once();child.wait.assert_called_once();self.assertTrue(all(f.closed for f in opened))
 def test_rpc_spawn_failure_closes_open_journals(self):
  import codex_native
  from unittest.mock import patch
  rpc=codex_native.module('spawn_failure_rpc',P/'validated/codex61_app_rpc.py')
  with tempfile.TemporaryDirectory() as d:
   opened=[];original=Path.open
   def tracked(path,*args,**kwargs):
    f=original(path,*args,**kwargs);opened.append(f);return f
   with patch.object(rpc.subprocess,'Popen',side_effect=OSError('spawn failed')),patch.object(Path,'open',tracked):
    with self.assertRaisesRegex(OSError,'spawn failed'):rpc.RPC(d,d)
   self.assertTrue(all(f.closed for f in opened))
 def test_codex_thread_gate_failure_closes_initialized_rpc(self):
  import codex_native
  from unittest.mock import patch,MagicMock
  from types import SimpleNamespace
  closed=[]
  class FakeRPC:
   def __init__(self,*a,**kw):pass
   def call(self,*a,**kw):return {'thread':{'id':'fresh'},'model':'WRONG','reasoningEffort':'medium','activePermissionProfile':{'id':'p0_eval'}}
   def close(self):closed.append(True)
  api=SimpleNamespace(RPC=FakeRPC);guard=SimpleNamespace(require_controller_python=lambda:None,runtime_identity=lambda:{})
  profile={'guard':{'fixture':'/fixture'},'codex_cli':'/codex','node':'/node','rg':'/rg','launch_env':{},'os_home':'/fresh','codex_home':'/freshcodex','model':'gpt-6.1-sol'}
  with tempfile.TemporaryDirectory() as d,patch.object(codex_native,'module',side_effect=[guard,api]):
   with self.assertRaisesRegex(RuntimeError,'Unexpected native thread'):codex_native.CodexNative(profile,Path(d)/'out')
  self.assertEqual(closed,[True])

class CodexConfigTests(unittest.TestCase):
 def test_resolved_runtime_aliases_deduplicate_before_actual_toml_parse(self):
  import codex_native,tomllib
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);target=root/'runtime';other=root/'distinct-runtime';target.mkdir();other.mkdir();alias=root/'runtime-link';alias.symlink_to(target,target_is_directory=True)
   profile={'codex_home':str(root/'home'),'codex_auth':str(root/'unread-auth'),'guard':{'fixture':str(root/'fixture'),'plugin_root':str(root/'plugin')},'minimal_runtime_read_roots':[str(alias),str(target),str(other)],'launch_env':{'PATH':'/usr/bin:/bin'},'disabled_plugin_ids':[],'disabled_skill_relatives':[]}
   codex_native.write_config(profile)
   config=tomllib.loads((root/'home/config.toml').read_text());fs=config['permissions']['p0_eval']['filesystem']
   self.assertEqual(fs[str(target.resolve())],'read');self.assertEqual(fs[str(other.resolve())],'read');self.assertNotIn(str(alias),fs);self.assertEqual(sum(key==str(target.resolve()) for key in fs),1)

class AuthTransportTests(unittest.TestCase):
 def test_claude_child_uses_memory_only_fish_auth_without_host_state_or_serialization(self):
  import claude_native,os
  from unittest.mock import patch,MagicMock
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);profile={'guard':{'fixture':str(root/'fixture'),'plugin_root':str(root/'plugin')},'skills':{},'plugin_inventory':{},'claude_config':str(root/'fresh-config'),'os_home':str(root/'fresh-home'),'launch_env':{'PATH':'/usr/bin:/bin'},'claude_cli':'/native-claude','mcp_config':str(root/'mcp.json'),'model':'claude-sonnet-5-5','effort':'medium'};child=MagicMock()
   with patch.dict(os.environ,{'CLAUDE_CODE_OAUTH_TOKEN':'test-canary-never-inherit','HOST_HISTORY_CANARY':'never-inherit'}),patch.object(claude_native.subprocess,'Popen',return_value=child) as launch,patch.object(claude_native.threading,'Thread'),patch.object(claude_native,'load_claude_auth',return_value={'CLAUDE_CODE_OAUTH_TOKEN':'TEST_OPAQUE_FISH_TOKEN'},create=True):
    actor=claude_native.ClaudeNative(profile,root/'out',False)
    try:
     env=launch.call_args.kwargs['env'];self.assertEqual(env.get('CLAUDE_CODE_OAUTH_TOKEN'),'TEST_OPAQUE_FISH_TOKEN');self.assertNotIn('CLAUDE_SECURESTORAGE_CONFIG_DIR',env);self.assertEqual(env.get('MCP_TIMEOUT'),'120000');self.assertEqual(env['HOME'],profile['os_home']);self.assertEqual(env['CLAUDE_CONFIG_DIR'],profile['claude_config']);self.assertNotEqual(env['CLAUDE_CODE_OAUTH_TOKEN'],'test-canary-never-inherit');self.assertNotIn('HOST_HISTORY_CANARY',env)
    finally:actor.close()
   for artifact in (root/'out').rglob('*'):
    if artifact.is_file():self.assertNotIn('TEST_OPAQUE_FISH_TOKEN',artifact.read_text())
   self.assertNotIn('TEST_OPAQUE_FISH_TOKEN',json.dumps(profile))
 def test_codex_child_does_not_inherit_claude_override_or_other_host_environment(self):
  import codex_native,os
  from unittest.mock import patch,MagicMock
  rpc=codex_native.module('auth_boundary_rpc',P/'validated/codex61_app_rpc.py')
  with tempfile.TemporaryDirectory() as d:
   child=MagicMock()
   with patch.dict(os.environ,{'CLAUDE_SECURESTORAGE_CONFIG_DIR':'','CLAUDE_CODE_OAUTH_TOKEN':'test-canary-never-inherit','HOST_HISTORY_CANARY':'never-inherit'}),patch.object(rpc.subprocess,'Popen',return_value=child) as launch,patch.object(rpc.threading,'Thread'),patch.object(rpc.RPC,'call',return_value={}):
    actor=rpc.RPC(d,d)
    try:
     env=launch.call_args.kwargs['env'];self.assertNotIn('CLAUDE_SECURESTORAGE_CONFIG_DIR',env);self.assertNotIn('CLAUDE_CODE_OAUTH_TOKEN',env);self.assertNotIn('HOST_HISTORY_CANARY',env)
    finally:actor.close()

class FishAuthSourceTests(unittest.TestCase):
 def test_fish_capture_uses_only_allowlisted_auth_and_discards_noise_without_printing(self):
  import auth_transport,io,contextlib
  from types import SimpleNamespace
  from unittest.mock import patch
  payload={'CLAUDE_CODE_OAUTH_TOKEN':'TEST_OPAQUE_FISH_TOKEN','ANTHROPIC_API_KEY':'TEST_OTHER_AUTH'};output=io.StringIO()
  with patch.object(auth_transport.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='startup noise\nP0_CLAUDE_AUTH='+json.dumps(payload)+'\n',stderr='discard me')) as child,contextlib.redirect_stdout(output):
   auth=auth_transport.load_claude_auth()
  self.assertEqual(auth,{'CLAUDE_CODE_OAUTH_TOKEN':'TEST_OPAQUE_FISH_TOKEN'});self.assertEqual(output.getvalue(),'');self.assertEqual(child.call_args.args[0][:2],['/opt/homebrew/bin/fish','-lc']);self.assertTrue(child.call_args.kwargs['capture_output']);self.assertNotIn('TEST_OPAQUE_FISH_TOKEN',json.dumps(child.call_args.args))
 def test_invalid_fish_payload_fails_without_leaking_output_or_exception(self):
  import auth_transport
  from types import SimpleNamespace
  from unittest.mock import patch
  for stdout in ['TEST_PRIVATE_INVALID', 'P0_CLAUDE_AUTH='+json.dumps({'UNKNOWN':'TEST_PRIVATE_INVALID'})]:
   with patch.object(auth_transport.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=stdout,stderr='TEST_PRIVATE_INVALID')):
    with self.assertRaises(RuntimeError) as error:auth_transport.load_claude_auth()
    self.assertNotIn('TEST_PRIVATE_INVALID',str(error.exception))

class SelectedPolicyTests(unittest.TestCase):
 def seal(self):
  seal={k:k for k in m.GO_KEYS};seal.update(models={'codex':'gpt-6.1-sol','claude':'claude-sonnet-5-5'},efforts={'codex':'medium','claude':'medium'},n=1,actors=8);return seal
 def test_selected_go_cannot_enter_run_all_or_create_marker(self):
  import run
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);seal=self.seal();go={**seal,'ROOTGO':True,'selected_keys':['allowed'],'execute_actor_count':1};m.publish(root/'seal.json',seal);m.publish(root/'go.json',go)
   with patch.object(run,'checked_schedule',return_value=[{'key':'excluded'}]),patch.object(run,'run_one',side_effect=AssertionError('must not start actor')) as actor:
    with self.assertRaises(PermissionError):run.run_all(root,root/'go.json')
    actor.assert_not_called();self.assertFalse((root/'RUN-STARTED.json').exists())
 def test_excluded_key_run_one_rejected_before_native_constructor(self):
  import run
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);seal=self.seal();go={**seal,'ROOTGO':True,'selected_keys':['allowed'],'execute_actor_count':1};m.publish(root/'go.json',go);m.publish(root/'proofs/excluded/result.json',{'status':'ready'});m.publish(root/'profile/proxy.json',{'diagnostic_fetch':False});profile={'job':{'harness':'claude'},'mcp_config':str(root/'profile/mcp.json')}
   with patch.object(run,'validate',return_value=(seal,profile)),patch.object(run,'ClaudeNative',side_effect=AssertionError('constructor reached')) as actor:
    with self.assertRaises(PermissionError):run.run_one(root,'excluded',root/'go.json')
    actor.assert_not_called();self.assertFalse((root/'actors/excluded').exists())

class ProtocolErrorCodeTests(unittest.TestCase):
 def test_unknown_rpc_method_is_method_not_found_and_scope_denials_stay_denied(self):
  import codex_native,io,os
  from unittest.mock import patch,MagicMock
  proxy=codex_native.module('protocol_code_proxy',P/'validated/codex61_mcp_proxy.py')
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);cfg={'upstream_env':{},'audit_log':str(root/'audit.jsonl'),'forensic_dir':str(root/'private'),'upstream_stderr_log':str(root/'stderr'),'upstream_command':['not-executed']};m.publish(root/'cfg.json',cfg);child=MagicMock();child.stdout=[];child.stdin=io.StringIO();requests=[{'jsonrpc':'2.0','id':1,'method':'server/discover','params':{}},{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'index_codebase','arguments':{}}},{'jsonrpc':'2.0','id':3,'method':'resources/read','params':{'uri':'file:///outside'}}];output=io.StringIO()
   with patch.dict(os.environ,{'BENCH_MCP_PROXY_CONFIG':str(root/'cfg.json')}),patch.object(proxy.subprocess,'Popen',return_value=child),patch.object(proxy.threading,'Thread'),patch.object(proxy.sys,'stdin',io.StringIO(''.join(json.dumps(q)+'\n' for q in requests))),patch.object(proxy.sys,'stdout',output):proxy.main()
   replies={r['id']:r for line in output.getvalue().splitlines() if (r:=json.loads(line)).get('id')};self.assertEqual(replies[1]['error']['code'],-32601);self.assertEqual(replies[2]['error']['code'],-32001);self.assertEqual(replies[3]['error']['code'],-32001);self.assertEqual(child.stdin.getvalue(),'')

class SessionTimingTests(unittest.TestCase):
 def test_startup_hooks_are_in_session_total_not_hidden_by_user_timer(self):
  self.assertTrue(hasattr(m,'session_times'),'missing session-wide timer contract');r=m.session_times(10,40,60,80);self.assertEqual(r['session_total_wall_seconds'],70);self.assertEqual(r['pre_user_wall_seconds'],30);self.assertEqual(r['user_request_wall_seconds'],20);self.assertEqual(r['post_user_wall_seconds'],20)
class ScopedMetadataAndHooksTests(unittest.TestCase):
 def test_tool_search_only_discovers_target_server_tools(self):
  cfg={'fixture':'/fixture','plugin_root':'/plugin','project':'fixture','collection':'code_fixture','skill_names':[]}
  self.assertTrue(m.tool_decision('ToolSearch',{'query':'select:mcp__tea-rags__find_symbol'},cfg)['allow'])
  self.assertTrue(m.tool_decision('McpToolSearch',{'query':'+tea-rags current index status'},cfg)['allow'])
  self.assertTrue(m.tool_decision('ToolSearch',{'query':'find_symbol'},cfg)['allow']);self.assertTrue(m.tool_decision('ToolSearch',{'query':'semantic_search'},cfg)['allow'])
  for q in ['select:mcp__foreign__read','search all tools','select:mcp__tea-rags__index_codebase','+tea-rags mcp__foreign__read']:self.assertFalse(m.tool_decision('ToolSearch',{'query':q},cfg)['allow'])
 def test_parallel_hook_spans_are_union_not_sum(self):
  self.assertTrue(hasattr(m,'hook_union_seconds'),'missing observed-hook timing');self.assertEqual(m.hook_union_seconds([(1,4),(2,5),(7,8)]),5)
 def test_backend_env_pins_override_fresh_actor_home_for_cli_and_mcp(self):
  self.assertTrue(hasattr(m,'trusted_backend_env'),'missing backend identity pin')
  cfg={'backend_data_dir':'/real/.tea-rags','embedded_storage_path':'/real/.tea-rags/qdrant'};env=m.trusted_backend_env({'HOME':'/real','TRAJECTORY_GIT_ANCHOR':'old'}, {'QDRANT_URL':'embedded'},cfg)
  self.assertEqual(env['HOME'],'/real');self.assertEqual(env['TEA_RAGS_DATA_DIR'],'/real/.tea-rags');self.assertEqual(env['QDRANT_EMBEDDED_STORAGE_PATH'],'/real/.tea-rags/qdrant');self.assertNotIn('TRAJECTORY_GIT_ANCHOR',env);self.assertEqual(env['TEA_RAGS_AUTO_UPDATE'],'0')
class EntrypointTests(unittest.TestCase):
 def test_importing_controller_never_launches_native_or_model_process(self):
  from unittest.mock import patch
  import importlib
  with patch('subprocess.Popen',side_effect=AssertionError('native process during import')):r=importlib.import_module('run')
  self.assertTrue(callable(r.prepare));self.assertTrue(callable(r.prove));self.assertTrue(callable(r.run_all))
if __name__=='__main__':unittest.main()
