"""No-client integration tests for the controller callback and launch guard."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
from controller_io import recover_journal, runtime_identity

HERE = Path(__file__).resolve().parent
# PIN-UPDATED: new same-thread readiness protocol requires a complete inventory fixture.
REAL_TOOLS = ['find_co_changed','find_cycles','find_similar','find_symbol','get_architecture_report','get_callees','get_callers','get_index_metrics','get_index_status','get_naming_lexicon','get_ontology_report','hybrid_search','list_projects','rank_chunks','search_code','semantic_search','trace_path']

def load_runner():
    api = types.ModuleType('codex61_app_rpc')
    api.REPO = '/offline-fixture'
    api.RPC = mock.Mock()
    with mock.patch.dict(sys.modules, {'codex61_app_rpc': api}):
        spec = importlib.util.spec_from_file_location('offline_runner', HERE/'runner.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
    return runner

class AdapterTests(unittest.TestCase):
    def setup_base(self, base):
        manifest = {'ROOTGO':True,'preflight_ready':True,'independent_security_review':'ready',
                    'runs_authorized':['A'],'order':['A'],'prepared_model_turns':0,
                    'backend_env':{'A':{}},'controller_python':runtime_identity(),'real_tool_names':REAL_TOOLS}
        (base/'final-manifest.json').write_text(json.dumps(manifest))
        (base/'questions-only.json').write_text(json.dumps([{'id':'Q%02d'%i,'question':'fixture'} for i in range(1,40)]))

    def fake_rpc(self):
        rpc = mock.Mock()
        serial = iter(range(1,40))
        def call(method, args, timeout=None):
            if method == 'thread/start':
                return {'thread':{'id':'fixture-thread'},'model':'gpt-6.1-sol','reasoningEffort':'medium',
                        'activePermissionProfile':{'id':'benchmark'}}
            if method == 'mcpServerStatus/list':
                return {'data':[{'name':'tea-rags','runtimeStatus':'connected','tools':{name:{} for name in REAL_TOOLS},'toolsError':None}],'nextCursor':None}
            if method == 'turn/start':
                return {'turn':{'id':'fixture-turn-%d'%next(serial)}}
            if method == 'thread/read':
                return {'thread':{'id':'fixture-thread'}}
            raise AssertionError(method)
        rpc.call.side_effect = call
        return rpc

    def test_success_uses_one_journal_record_per_callback_and_one_final_snapshot(self):
        runner = load_runner()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d); self.setup_base(base); runner.configure(base)
            rpc = self.fake_rpc()
            delivered = []
            def await_offline(rpc, turn_id, on_event):
                events = [{'method':'turn/started','params':{'turn':{'id':turn_id}}},
                          {'method':'fixture/opaque','params':{'n':1}},
                          {'method':'turn/completed','params':{'turn':{'id':turn_id,'status':'completed'}}}]
                for event in events: on_event(event)
                delivered.append(events)
                return {'events':events,'requests':[],'status':'completed','native_turn_status':'completed','cleanup':None}
            with mock.patch.object(runner,'verify_frozen',return_value=0), mock.patch.object(runner,'RPC',return_value=rpc), mock.patch.object(runner,'await_turn',side_effect=await_offline), mock.patch('builtins.print'):
                runner.execute('A')
            out=base/'runs/A'
            for number,events in enumerate(delivered,1):
                prefix='Q%02d'%number
                self.assertTrue((out/(prefix+'-partial-events.jsonl')).exists(), 'Missing per-event journal')
                self.assertEqual(recover_journal(out/(prefix+'-partial-events.jsonl'))['events'],events)
                self.assertEqual(json.loads((out/(prefix+'-events.json')).read_text()),events)
                self.assertFalse((out/(prefix+'-partial-events.json')).exists())
            status=json.loads((out/'status.json').read_text())
            self.assertEqual(status['controller_persistence']['measurement'],'OBSERVATION')
            self.assertEqual(status['turns_with_observed_final_answer'],0)
            self.assertEqual(status['native_completed_turns'],39)
            marks=json.loads((out/'marks.json').read_text())
            self.assertEqual(marks[0]['controller_persistence']['event_count'],3)
            rpc.close.assert_called_once()

    def test_interrupt_preserves_recoverable_journal_and_partial_snapshot(self):
        runner=load_runner()
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);self.setup_base(base);runner.configure(base);rpc=self.fake_rpc()
            def fail(rpc,turn_id,on_event):
                on_event({'method':'fixture/before-interrupt','params':{'n':1}})
                raise KeyboardInterrupt('offline fixture')
            with mock.patch.object(runner,'verify_frozen',return_value=0), mock.patch.object(runner,'RPC',return_value=rpc), mock.patch.object(runner,'await_turn',side_effect=fail), self.assertRaises(KeyboardInterrupt):
                runner.execute('A')
            out=base/'runs/A'
            self.assertTrue((out/'Q01-partial-events.jsonl').exists(), 'Missing interrupted-event journal')
            events=recover_journal(out/'Q01-partial-events.jsonl')['events']
            self.assertEqual(json.loads((out/'Q01-partial-events.json').read_text()),events)
            self.assertFalse((out/'Q01-events.json').exists())
            status=json.loads((out/'status.json').read_text())
            self.assertFalse(status['valid'])
            self.assertEqual(status['controller_persistence']['event_count'],1)
            rpc.close.assert_called_once()

    def test_runtime_manifest_cannot_drift_from_frozen_record(self):
        runner=load_runner()
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);runner.configure(base)
            expected=runtime_identity();record=dict(expected);record['cache_tag']='different'
            (base/'controller-python.json').write_text(json.dumps(record))
            (base/'corpus-readable-inventory.json').write_text('{}')
            manifest={'controller_python':expected,'frozen_files':{},'corpus_commit':'fixture-head'}
            with mock.patch.object(runner.subprocess,'check_output',side_effect=['fixture-head\n','']),mock.patch.object(runner,'corpus_inventory',return_value={}):
                with self.assertRaisesRegex(AssertionError,'runtime record'):
                    runner.verify_frozen(manifest)

    def test_launcher_rejects_runtime_mismatch_before_consuming_rootgo(self):
        spec=importlib.util.spec_from_file_location('offline_launch',HERE/'run.py')
        launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            expected=runtime_identity();expected['executable_sha256']='different'
            manifest={'ROOTGO':False,'controller_python':expected,'order':['A'],'runs_authorized':['A'],
                      'runs_per_condition':1,'model':'gpt-6.1-sol','effort':'medium',
                      'prepared_model_turns':0,'preflight_ready':True,'frozen_files':{}}
            (base/'final-manifest.json').write_text(json.dumps(manifest))
            for name in ('independent-review.json','focused-cases.json','transport-preservation.json'):
                (base/name).write_text(json.dumps({'verdict':'PASS','frozen_files_sha256':launcher.fingerprint({})}))
            fake_runner=types.ModuleType('codex61_runner');fake_runner.configure=mock.Mock();fake_runner.verify_frozen=mock.Mock();fake_runner.execute=mock.Mock()
            with mock.patch.dict(sys.modules,{'codex61_runner':fake_runner}),mock.patch.object(sys,'argv',['run.py','--base',d,'--rootgo']),self.assertRaisesRegex(RuntimeError,'runtime'):
                launcher.main()
            self.assertFalse((base/'ROOTGO.json').exists())
            self.assertFalse((base/'runs').exists())

if __name__=='__main__':unittest.main()
