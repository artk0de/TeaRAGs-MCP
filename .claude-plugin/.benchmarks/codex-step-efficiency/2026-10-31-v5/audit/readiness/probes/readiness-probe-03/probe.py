"""Fresh no-model same-thread MCP readiness probe. No prepared profile mutations."""
import hashlib,importlib.util,json,shutil,sys,time
from pathlib import Path
ROOT=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp');BASE=Path(__file__).resolve().parent/'runtime';ARCHIVE=ROOT/'.tmp/gruntworx_codex_A_2026-10-31_v4_01'
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);out=importlib.util.module_from_spec(spec);spec.loader.exec_module(out);return out
def dump(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
BASE.mkdir();(BASE/'lib').mkdir()
for name in ['codex61_app_rpc.py','codex61_mcp_proxy.py','codex61_cli.py','codex61_metrics.py','codex61_context_metrics.py','protocol.py']:
 shutil.copy2(ARCHIVE/'lib'/name,BASE/'lib'/name)
(BASE/'lib/codex61').mkdir()
shutil.copy2(ARCHIVE/'lib/codex61/metadata-table-schemas.json',BASE/'lib/codex61/metadata-table-schemas.json')
shutil.copytree(ROOT/'.tmp/codex-speed-v5-evals/sources/current-policy',BASE/'final-marketplace')
(BASE/'final-runtime').symlink_to(ARCHIVE/'final-runtime',target_is_directory=True)
shutil.copy2(ARCHIVE/'upstream-template.json',BASE/'upstream-template.json')
api=module('readiness_probe_api',BASE/'lib/codex61_app_rpc.py');prep=module('readiness_probe_prepare',ROOT/'.tmp/only-a-benchmark-v4/prepare.py');prep.BASE=BASE;prep.ROOT=ROOT
expected=prep.inventory(BASE/'final-marketplace/harness/codex/tea-rags')
extra,plugin=prep.setup(api,BASE/'home','probe',expected)
proxy=module('readiness_probe_guard',BASE/'lib/codex61_mcp_proxy.py');required=set(proxy.READ_TOOLS)
# Fresh-profile-only narrow PATH and exact transport-file permission experiment.
import tomllib
config=BASE/'home/config.toml';text=config.read_text();before=sha(config)
old=tomllib.loads(text)['shell_environment_policy']['set']['PATH']
text=text.replace('PATH = '+json.dumps(old),'PATH = '+json.dumps(extra['PATH']))
allowed=[BASE/'bin-probe/tea-rags',BASE/'proxy-probe.json',*[BASE/'lib'/name for name in ['codex61_cli.py','codex61_mcp_proxy.py','codex61_metrics.py','codex61_context_metrics.py']],BASE/'lib/codex61/metadata-table-schemas.json']
text=text.replace('[permissions.benchmark.filesystem]\n','[permissions.benchmark.filesystem]\n'+''.join(json.dumps(str(path))+' = "read"\n' for path in allowed))
config.write_text(text)
dump(BASE/'narrow-profile-experiment.json',{'before_config_sha256':before,'after_config_sha256':sha(config),'exact_read_files':list(map(str,allowed)),'no_directory_grants':True,'model_turns':0})
rpc=api.RPC(BASE/'home',BASE/'same-thread',extra_env=extra,allow_model_turns=False)
try:
 thread=rpc.call('thread/start',{'cwd':api.REPO,'model':'gpt-6.1-sol','permissions':'benchmark','approvalPolicy':'never','ephemeral':True,'experimentalRawEvents':True});tid=thread['thread']['id']
 status=rpc.call('mcpServerStatus/list',{'threadId':tid,'serverName':'tea-rags','detail':'toolsAndAuthOnly','limit':100});dump(BASE/'same-thread-inventory.json',status)
 result={'model_turns':0,'thread_id':tid,'native_mcp_status':status['data'][0]['runtimeStatus'],'native_tool_count':len(status['data'][0]['tools']),'checks':{}}
 for name,command in [('PATH',['/usr/bin/printenv','PATH']),('command_v',['/bin/zsh','-c','command -v tea-rags']),('resource_cli',['/bin/zsh','-c','tea-rags resource tea-rags://guide/navigation'])]:
  row=rpc.call('command/exec',{'command':command,'cwd':api.REPO,'permissionProfile':'benchmark','timeoutMs':20000})
  result['checks'][name]={'exitCode':row['exitCode'],'stdout_bytes':len(row['stdout'].encode()),'stdout_sha256':hashlib.sha256(row['stdout'].encode()).hexdigest(),'stderr':row['stderr']}
  if name in ['PATH','command_v']:result['checks'][name]['stdout']=row['stdout']
 protected=[ROOT/'.claude/worktrees/codex-efficiency-v5/.claude-plugin/.benchmarks/codex-step-efficiency/2026-10-31-v5'/name for name in ['cases.json','grading.json','provenance.json']]+[ROOT/'.tmp/codex-speed-v5-evals/short_native.py',BASE/'home/auth.json',ROOT/'.codex/auth.json']
 code='import os\npaths='+repr(list(map(str,protected)))+'\nfor path in paths:\n try:\n  fd=os.open(path,os.O_RDONLY);os.close(fd);print("OPEN_ALLOWED")\n except OSError as e:print("OPEN_DENIED",e.errno)'
 result['denial_open_only_no_contents']=rpc.call('command/exec',{'command':[str(Path(sys.executable).resolve()),'-c',code],'cwd':api.REPO,'permissionProfile':'benchmark','timeoutMs':10000})
 dump(BASE/'result.json',result);print(json.dumps(result,indent=2))
finally:rpc.close()
