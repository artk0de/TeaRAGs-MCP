"""Adversarial guard checks, no model and no actual corpus mutation."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import codex61_mcp_proxy as proxy

BASE=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/codex61/proxy-proof')
BASE.mkdir(parents=True,exist_ok=True)
proof=[]
def check(name,condition):
    proof.append({'case':name,'passed':bool(condition)})
    if not condition:raise AssertionError(name)

def rejects(name,args):
    try:proxy.guard_call(name,args)
    except ValueError:return True
    return False

check('cross_project',rejects('find_symbol',{'project':'tea-rags','symbol':'X'}))
check('raw_collection',rejects('find_symbol',{'collection':proxy.COLLECTION,'symbol':'X'}))
check('mutator',rejects('index_codebase',{}))
check('collection_info_removed',rejects('get_collection_info',{'name':'foreign'}))
check('nested_path',rejects('get_naming_lexicon',{'names':[{'path':'../../outside/a.rb','name':'X','kind':'type'}]}))
check('nested_docs',rejects('find_symbol',{'symbols':['docs/secret.rb']}))
check('encoded_docs',rejects('find_symbol',{'relativePath':'%64ocs/secret.rb'}))
check('document_id',rejects('find_symbol',{'symbol':'doc:abc'}))
check('resource_other_project',not proxy.safe_resource('tea-rags://project/tea-rags/digest'))
check('resource_arbitrary_query',not proxy.safe_resource('tea-rags://project/'+proxy.PROJECT+'/digest?path=/outside'))
check('resource_safe_digest',proxy.safe_resource('tea-rags://project/'+proxy.PROJECT+'/digest'))
check('resource_safe_guide',proxy.safe_resource('tea-rags://guide/navigation'))
original=proxy.REPO
with tempfile.TemporaryDirectory(dir=BASE) as t:
    fixture=Path(t);(fixture/'corpus').mkdir();(fixture/'outside').write_text('canary')
    (fixture/'corpus/escape.rb').symlink_to(fixture/'outside')
    proxy.REPO=str(fixture/'corpus')
    check('relative_symlink',not proxy.safe_path('escape.rb'))
    proxy.REPO=original
check('missing_body_locator',proxy.clean({'payload':{'content':'CANARY'}})=={})
check('doc_table_removed',not proxy.clean({'columns':['relativePath','content'],'rows':[['docs/x.rb','CANARY']]})['rows'])
check('no_path_body_table_removed',not proxy.clean({'columns':['content'],'rows':[['CANARY']]})['rows'])
check('null_locator_body_table_removed',not proxy.clean({'columns':['relativePath','content'],'rows':[[None,'CANARY']]})['rows'])
table=proxy.clean({'columns':['relativePath','content'],'rows':[['app/safe.rb','SAFE']],
 'attached':{'relativePath':'docs/private.rb','content':'CANARY'},'_meta':{'private':'CANARY'}})
check('table_sibling_body_sanitized','CANARY' not in json.dumps(table))
check('table_documentation_row_removed',not proxy.clean({'columns':['relativePath','chunkType','content'],'rows':[['app/safe.rb','documentation','CANARY']]})['rows'])
check('table_doc_id_row_removed',not proxy.clean({'columns':['relativePath','symbolId','content'],'rows':[['app/safe.rb','doc:private','CANARY']]})['rows'])
check('graph_locator_preserved',len(proxy.clean({'columns':['relPath','symbolId'],'rows':[['app/lib/tax_preparation/tax_automations/registry.rb','Registry']]})['rows'])==1)
req={'method':'tools/call','params':{'name':'find_symbol','arguments':{}}}
error=proxy.filtered_response({'result':{'isError':True,'content':[{'type':'text','text':'CANARY'}]}},req)
check('error_sanitized','CANARY' not in json.dumps(error))
embedded=proxy.filtered_response({'result':{'content':[{'type':'resource','resource':{'uri':'file:///outside','text':'CANARY'}}]}},req)
check('embedded_resource_removed','CANARY' not in json.dumps(embedded))
try:proxy.filtered_response({'result':{'content':[{'type':'text','text':'"CANARY"'}]}},req)
except ValueError:check('scalar_text_blocked',True)
else:check('scalar_text_blocked',False)

# Wire-level fake upstream: colliding server requests and unsolicited logs must
# not cross even when their ids match outstanding client requests.
fake=BASE/'fake_upstream.py'
fake.write_text('''import json,sys
for line in sys.stdin:
 m=json.loads(line)
 if 'method' not in m: continue
 rid=m.get('id')
 if rid is None: continue
 print(json.dumps({'jsonrpc':'2.0','method':'notifications/message','params':{'text':'CANARY_NOTIFICATION'}}),flush=True)
 if m['method']=='tools/list': result={'tools':[{'name':'find_symbol'},{'name':'index_codebase'},{'name':'get_collection_info'}]}
 elif m['method']=='tools/call':
  print(json.dumps({'jsonrpc':'2.0','id':rid,'method':'evil/request','params':{'text':'CANARY_COLLISION'}}),flush=True)
  print('CANARY_STDERR',file=sys.stderr,flush=True)
  result={'structuredContent':{'results':[{'payload':{'relativePath':'app/lib/tax_preparation/tax_automations/registry.rb','content':'SAFE_BODY'}},{'payload':{'relativePath':'docs/forbidden.rb','content':'CANARY_DOC'}},{'payload':{'content':'CANARY_UNLOCATED'}}]},'content':[]}
  if m.get('params',{}).get('arguments',{}).get('symbol')=='Bad': result={'content':[{'type':'text','text':'CANARY_REJECTED_RESPONSE'}]}
 else: result={'protocolVersion':'2024-11-05','capabilities':{},'serverInfo':{'name':'fake','version':'1'}}
 print(json.dumps({'jsonrpc':'2.0','id':rid,'result':result}),flush=True)
''')
cfg={'upstream_command':[sys.executable,str(fake)],'upstream_env':{},'audit_log':str(BASE/'audit.jsonl'),
 'upstream_stderr_log':str(BASE/'private-upstream-stderr.txt'),'forensic_dir':str(BASE/'private-forensic')}
path=BASE/'config.json';path.write_text(json.dumps(cfg))
p=subprocess.Popen([sys.executable,str(Path(proxy.__file__))],env={**os.environ,'BENCH_MCP_PROXY_CONFIG':str(path)},
 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
responses=[]
try:
 for rid,method,params in [(1,'initialize',{}),(2,'tools/list',{}),(3,'tools/call',{'name':'find_symbol','arguments':{'symbol':'Registry'}})]:
  p.stdin.write(json.dumps({'jsonrpc':'2.0','id':rid,'method':method,'params':params})+'\n');p.stdin.flush()
  line=p.stdout.readline();r=json.loads(line);responses.append(r)
  check('wire_response_id_'+str(rid),r.get('id')==rid and 'method' not in r)
 check('wire_no_canary','CANARY' not in json.dumps(responses))
 check('wire_read_tool_only',[t['name'] for t in responses[1]['result']['tools']]==['find_symbol'])
 check('wire_valid_body_preserved','SAFE_BODY' in json.dumps(responses))
 p.stdin.write(json.dumps({'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'find_symbol','arguments':{'symbol':'Bad'}}})+'\n');p.stdin.flush()
 rejected=json.loads(p.stdout.readline())
 check('wire_reject_sanitized','CANARY' not in json.dumps(rejected) and bool(rejected.get('error')))
 artifacts=list((BASE/'private-forensic').glob('*.json'))
 check('forensic_retains_raw_rejection',any('CANARY_REJECTED_RESPONSE' in f.read_text() for f in artifacts))
 record=next(json.loads(f.read_text()) for f in artifacts if 'CANARY_REJECTED_RESPONSE' in f.read_text())
 check('forensic_request_mapping',record['id']==4 and record['request']['params']['arguments']['symbol']=='Bad' and record['request']['_benchmark_forwarded_arguments']['project']==proxy.PROJECT)
 check('forensic_files_private',all(f.stat().st_mode & 0o077==0 for f in artifacts))
 p.stdin.close();p.wait(timeout=5)
 check('wire_stderr_isolated','CANARY' not in p.stderr.read())
finally:
 if p.poll() is None:p.kill();p.wait()
 (BASE/'proof.json').write_text(json.dumps(proof,indent=2))
print('proxy proof passed',len(proof),'checks')
