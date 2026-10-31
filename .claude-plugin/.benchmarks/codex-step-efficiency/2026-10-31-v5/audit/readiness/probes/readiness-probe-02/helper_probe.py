"""Native no-model positive check of the actual new helper, own scratch profile."""
import hashlib,importlib.util,json
from pathlib import Path
ROOT=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp');BASE=Path(__file__).resolve().parent/'runtime'
HELPER=ROOT/'.claude/worktrees/codex-efficiency-v5/.claude-plugin/.benchmarks/codex-step-efficiency/2026-10-31-v5/repro/mcp_readiness.py'
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
api=module('helper_probe_api',BASE/'lib/codex61_app_rpc.py');proxy=module('helper_probe_proxy',BASE/'lib/codex61_mcp_proxy.py');helper=module('actual_readiness_helper',HELPER)
extra={'PATH':str(BASE/'bin-probe')+':'+str(Path(api.NODE).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','BENCH_MCP_PROXY_CONFIG':str(BASE/'proxy-probe.json')}
rpc=api.RPC(BASE/'home',BASE/'same-thread-helper',extra_env=extra,allow_model_turns=False);calls=[];original=rpc.call
def call(method,params,timeout=180):
 calls.append({'method':method,'params':params});return original(method,params,timeout)
rpc.call=call
try:
 thread=rpc.call('thread/start',{'cwd':api.REPO,'model':'gpt-6.1-sol','permissions':'benchmark','approvalPolicy':'never','ephemeral':True,'experimentalRawEvents':True})
 result=helper.wait_for_mcp_ready(rpc,thread['thread']['id'],proxy.READ_TOOLS)
 result.update({'native_calls':calls,'helper_sha256':hashlib.sha256(HELPER.read_bytes()).hexdigest(),'native_api_sha256':hashlib.sha256((BASE/'lib/codex61_app_rpc.py').read_bytes()).hexdigest(),'no_turn_started':all(c['method']!='turn/start' for c in calls),'allow_model_turns':rpc.allow_model_turns})
 (BASE/'helper-native-result.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'model_turns':0,'no_turn_started':result['no_turn_started'],'method_order':[c['method'] for c in calls],'tools':len(result['inventory']['data'][0]['tools']),'status':result['inventory']['data'][0]['runtimeStatus'],'helper_sha256':result['helper_sha256']},indent=2))
finally:rpc.close()
