"""No-model readiness contract and runner ordering tests."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from mcp_readiness import wait_for_mcp_ready
import test_adapter_io as adapter_fixtures

TOOLS={'find_co_changed','find_cycles','find_similar','find_symbol','get_architecture_report','get_callees','get_callers','get_index_metrics','get_index_status','get_naming_lexicon','get_ontology_report','hybrid_search','list_projects','rank_chunks','search_code','semantic_search','trace_path'}
def inventory(state='connected',tools=None,**extra):
    return {'data':[{'name':'tea-rags','runtimeStatus':state,'tools':{name:{} for name in (TOOLS if tools is None else tools)},'toolsError':None,**extra}],'nextCursor':None}
class FakeRPC:
    def __init__(self,replies,events=()):self.replies=iter(replies);self.events=iter(events);self.pending=[];self.calls=[]
    def call(self,method,params,timeout=None):self.calls.append((method,params));return next(self.replies)
    def next(self,timeout):return next(self.events)

class ReadinessTests(unittest.TestCase):
    def test_connected_exact_inventory_uses_same_thread_before_turn(self):
        rpc=FakeRPC([inventory()])
        result=wait_for_mcp_ready(rpc,'thread-1',TOOLS)
        self.assertEqual(rpc.calls[0],('mcpServerStatus/list',{'threadId':'thread-1','serverName':'tea-rags','detail':'toolsAndAuthOnly','limit':100}))
        self.assertEqual(result['thread_id'],'thread-1')
        self.assertEqual(set(result['inventory']['data'][0]['tools']),TOOLS)
        self.assertEqual(result['model_turns'],0)

    def test_startup_ready_wait_preserves_all_pending_notifications(self):
        old={'method':'unrelated','params':{'n':1}}
        ready={'method':'mcpServer/startupStatus/updated','params':{'threadId':'thread-1','name':'tea-rags','status':'ready'}}
        rpc=FakeRPC([inventory('starting',set()),inventory()],[ready]);rpc.pending=[old]
        wait_for_mcp_ready(rpc,'thread-1',TOOLS)
        self.assertEqual(rpc.pending,[old,ready])
        self.assertEqual([call[0] for call in rpc.calls],['mcpServerStatus/list','mcpServerStatus/list'])

    def test_missing_or_extra_inventory_fails_closed(self):
        for tools in [set(),TOOLS-{'find_symbol'},TOOLS|{'unknown_tool'}]:
            with self.subTest(tools=len(tools)),self.assertRaisesRegex(RuntimeError,'inventory'):
                wait_for_mcp_ready(FakeRPC([inventory(tools=tools)]),'thread-1',TOOLS)

    def test_failed_state_tools_error_or_pagination_fails_closed(self):
        rows=[inventory('failed'),inventory(toolsError='discovery failed'),{'data':[],'nextCursor':None},{**inventory(),'nextCursor':'more'}]
        for row in rows:
            with self.subTest(row=row),self.assertRaises(RuntimeError):
                wait_for_mcp_ready(FakeRPC([row]),'thread-1',TOOLS)

    def test_other_thread_ready_does_not_release_gate(self):
        wrong={'method':'mcpServer/startupStatus/updated','params':{'threadId':'other','name':'tea-rags','status':'ready'}}
        failed={'method':'mcpServer/startupStatus/updated','params':{'threadId':'thread-1','name':'tea-rags','status':'failed','error':'fixture'}}
        rpc=FakeRPC([inventory('starting',set())],[wrong,failed])
        with self.assertRaisesRegex(RuntimeError,'failed'):
            wait_for_mcp_ready(rpc,'thread-1',TOOLS)
        self.assertEqual(rpc.pending,[wrong,failed])
        self.assertEqual(len(rpc.calls),1)

    def test_runner_orders_thread_inventory_then_turn(self):
        self.run_runner_gate(missing=False)

    def test_runner_missing_inventory_creates_no_turn(self):
        self.run_runner_gate(missing=True)

    def run_runner_gate(self,missing):
        runner=adapter_fixtures.load_runner();fixtures=adapter_fixtures.AdapterTests()
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);fixtures.setup_base(base)
            manifest=json.loads((base/'final-manifest.json').read_text());manifest['real_tool_names']=sorted(TOOLS);(base/'final-manifest.json').write_text(json.dumps(manifest));runner.configure(base)
            rpc=fixtures.fake_rpc();original=rpc.call.side_effect
            def call(method,args,**kwargs):
                if method=='mcpServerStatus/list':return inventory(tools=set() if missing else TOOLS)
                return original(method,args)
            rpc.call.side_effect=call
            def await_offline(rpc,turn_id,on_event):
                events=[{'method':'turn/completed','params':{'turn':{'id':turn_id,'status':'completed'}}}]
                for event in events:on_event(event)
                return {'events':events,'requests':[],'status':'completed','native_turn_status':'completed','cleanup':None}
            with mock.patch.object(runner,'verify_frozen',return_value=0),mock.patch.object(runner,'RPC',return_value=rpc),mock.patch.object(runner,'await_turn',side_effect=await_offline),mock.patch('builtins.print'):
                if missing:
                    with self.assertRaisesRegex(RuntimeError,'inventory'):runner.execute('A')
                else:runner.execute('A')
            methods=[c.args[0] for c in rpc.call.call_args_list]
            if missing:self.assertNotIn('turn/start',methods)
            else:self.assertEqual(methods[:3],['thread/start','mcpServerStatus/list','turn/start'])
            rpc.close.assert_called_once()

if __name__=='__main__':unittest.main()
