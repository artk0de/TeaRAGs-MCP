"""No-model native shell diagnostics in the fresh probe profile only."""
import importlib.util,json,sys
from pathlib import Path
BASE=Path(__file__).resolve().parent/'runtime'
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
api=module('readiness_shell_api',BASE/'lib/codex61_app_rpc.py')
extra={'PATH':str(BASE/'bin-probe')+':'+str(Path(api.NODE).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','BENCH_MCP_PROXY_CONFIG':str(BASE/'proxy-probe.json')}
rpc=api.RPC(BASE/'home',BASE/'same-thread-shell',extra_env=extra,allow_model_turns=False)
try:
 thread=rpc.call('thread/start',{'cwd':api.REPO,'model':'gpt-6.1-sol','permissions':'benchmark','approvalPolicy':'never','ephemeral':True,'experimentalRawEvents':True});tid=thread['thread']['id']
 inventory=rpc.call('mcpServerStatus/list',{'threadId':tid,'serverName':'tea-rags','detail':'toolsAndAuthOnly','limit':100});(BASE/'shell-same-thread-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
 result={'model_turns':0,'thread_id':tid,'launch_PATH':extra['PATH'],'api_login_flag_supported':False,'checks':{}}
 commands={
  'native_default_PATH':{'command':['/usr/bin/printenv','PATH']},
  'same_actor_shell_no_login':{'command':['/bin/zsh','-c','command -v tea-rags']},
  'no_login_explicit_launch_PATH':{'command':['/bin/zsh','-c','command -v tea-rags'],'env':{'PATH':extra['PATH']}},
  'shim_readable_in_profile':{'command':['/usr/bin/test','-r',str(BASE/'bin-probe/tea-rags')]}}
 for name,args in commands.items():
  result['checks'][name]=rpc.call('command/exec',{**args,'cwd':api.REPO,'permissionProfile':'benchmark','timeoutMs':10000})
 (BASE/'shell-diagnostics.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
finally:rpc.close()
