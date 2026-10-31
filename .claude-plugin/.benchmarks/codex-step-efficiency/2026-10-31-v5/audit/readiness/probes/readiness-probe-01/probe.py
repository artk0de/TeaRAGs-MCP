"""Fresh no-model same-thread MCP readiness probe. No prepared profile mutations."""
import hashlib,importlib.util,json,shutil,sys,time
from pathlib import Path
ROOT=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp');BASE=Path(__file__).resolve().parent/'runtime';ARCHIVE=ROOT/'.tmp/gruntworx_codex_A_2026-10-31_v4_01'
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);out=importlib.util.module_from_spec(spec);spec.loader.exec_module(out);return out
def dump(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
BASE.mkdir();(BASE/'lib').mkdir()
for name in ['codex61_app_rpc.py','codex61_mcp_proxy.py']:
 shutil.copy2(ARCHIVE/'lib'/name,BASE/'lib'/name)
shutil.copytree(ROOT/'.tmp/codex-speed-v5-evals/sources/current-policy',BASE/'final-marketplace')
(BASE/'final-runtime').symlink_to(ARCHIVE/'final-runtime',target_is_directory=True)
shutil.copy2(ARCHIVE/'upstream-template.json',BASE/'upstream-template.json')
api=module('readiness_probe_api',BASE/'lib/codex61_app_rpc.py');prep=module('readiness_probe_prepare',ROOT/'.tmp/only-a-benchmark-v4/prepare.py');prep.BASE=BASE;prep.ROOT=ROOT
expected=prep.inventory(BASE/'final-marketplace/harness/codex/tea-rags')
extra,plugin=prep.setup(api,BASE/'home','probe',expected)
proxy=module('readiness_probe_guard',BASE/'lib/codex61_mcp_proxy.py');required=set(proxy.READ_TOOLS)
rpc=api.RPC(BASE/'home',BASE/'same-thread',extra_env=extra,allow_model_turns=False)
started=time.monotonic();records=[]
try:
 thread=rpc.call('thread/start',{'cwd':api.REPO,'model':'gpt-6.1-sol','permissions':'benchmark','approvalPolicy':'never','ephemeral':True,'experimentalRawEvents':True});tid=thread['thread']['id'];dump(BASE/'thread-start.json',thread)
 params={'threadId':tid,'serverName':'tea-rags','detail':'toolsAndAuthOnly','limit':100}
 status=rpc.call('mcpServerStatus/list',params,timeout=60);dump(BASE/'same-thread-inventory.json',status)
 rows=[row for row in status['data'] if row['name']=='tea-rags'];assert len(rows)==1
 row=rows[0];actual=set(row['tools'])
 assert row.get('runtimeStatus')=='connected',row.get('runtimeStatus')
 assert not row.get('toolsError'),row.get('toolsError')
 assert actual==required and len(actual)==17,(actual,required)
 record={'verdict':'READY_IN_SAME_RPC_BEFORE_ANY_TURN','model_turns':0,'allow_model_turns':False,'thread_id':tid,'params':params,'runtimeStatus':row['runtimeStatus'],'real_tools':sorted(actual),'tool_count':len(actual),'wall_seconds':time.monotonic()-started,'limits':['Confirms same-thread MCP runtime/inventory readiness, not code-mode ALL_TOOLS projection without a model turn','No baseline/flat/controller/profile files mutated; fresh scratch only'],'source_sha256':{str(path):sha(path) for path in [ARCHIVE/'lib/codex61_app_rpc.py',ROOT/'.tmp/only-a-benchmark-v4/prepare.py',Path(__file__)]},'profile_sha256':{str(path):sha(path) for path in [BASE/'home/config.toml',BASE/'proxy-probe.json',BASE/'bin-probe/tea-rags']},'plugin_inventory':expected}
 dump(BASE/'result.json',record)
 print(json.dumps({k:record[k] for k in ['verdict','model_turns','thread_id','runtimeStatus','tool_count','wall_seconds']},indent=2))
finally:rpc.close()
