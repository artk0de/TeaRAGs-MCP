"""New-runner integration controls; no native process or backend calls."""
import copy,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P))
import policy,run,scoped_proxy
class DomainRunnerTests(unittest.TestCase):
 def test_five_case_inventory_and_explicit_selected_order(self):
  cases=[{'id':x,'prompt':'literal '+x} for x in ['D01','D02','F01','F02','B01']]
  jobs=policy.jobs(cases);self.assertEqual(len(jobs),20);self.assertEqual(len({j['key'] for j in jobs}),20)
  selected=run.select_schedule(jobs,['D01','D02','F01','F02']);self.assertEqual(len(selected),16);self.assertNotIn('B01',{j['case_id'] for j in selected})
  for wrong in [[],['D01','D01'],['missing']]:
   with self.subTest(wrong=wrong),self.assertRaises(ValueError):run.select_schedule(jobs,wrong)
 def test_variant_source_is_explicit_not_host_plugin(self):
  with tempfile.TemporaryDirectory() as d:
   roots={};versions={}
   for v,version in [('baseline','0.55.1'),('candidate','0.55.2')]:
    roots[v]={};versions[v]={}
    for h,folder in [('codex','.codex-plugin'),('claude','.claude-plugin')]:
     p=Path(d)/v/h;(p/folder).mkdir(parents=True);(p/folder/'plugin.json').write_text(json.dumps({'version':version}));roots[v][h]=str(p);versions[v][h]=version
   spec={'variant_plugin_roots':roots,'variant_plugin_versions':versions};self.assertEqual(run.selected_plugin(spec,{'variant':'candidate','harness':'codex'})['version'],'0.55.2')
   del roots['candidate']['codex']
   with self.assertRaises((ValueError,KeyError)):run.selected_plugin(spec,{'variant':'candidate','harness':'codex'})
 def response(self):return {'id':3,'result':{'structuredContent':{'results':[{'relativePath':'src/refund-settlement/status.ts','content':'export const resource = "refund_settlement";'}]}}}
 def request(self):return {'method':'tools/call','params':{'name':'find_symbol','arguments':{'relativePath':'src/refund-settlement/status.ts'}},'_benchmark_forwarded_arguments':{'relativePath':'src/refund-settlement/status.ts','project':'external','path':'/fixture'}}
 def test_actual_forwarded_args_filtered_response_and_audit_before_delivery(self):
  with tempfile.TemporaryDirectory() as d:
   cfg={'fixture':'/fixture','project':'external','replay':{'actor_id':'candidate-codex-F02','case_id':'F02','audit_log':str(Path(d)/'replay.jsonl')}};m=SimpleNamespace(filtered_response=lambda msg,req:copy.deepcopy(msg));scoped_proxy.attach_replay(cfg,m);original=self.response();first=m.filtered_response(original,self.request());row=first['result']['structuredContent']['results'][0];self.assertIn('refund_processing',row['content']);self.assertEqual(row['treeState'],'modified');self.assertIn('refund_settlement',original['result']['structuredContent']['results'][0]['content'])
   second=m.filtered_response(original,self.request());self.assertIn('refund_settlement',second['result']['structuredContent']['results'][0]['content']);self.assertNotIn('treeState',second['result']['structuredContent']['results'][0]);audit=[json.loads(x) for x in Path(cfg['replay']['audit_log']).read_text().splitlines()];self.assertEqual(len(audit),2);self.assertEqual(audit[0]['requested_locators'],{'relativePath':'src/refund-settlement/status.ts'});self.assertEqual(audit[0]['forwarded_locators']['project'],'external');self.assertNotIn('refund_processing',json.dumps(audit));self.assertEqual(audit[1]['target_read_ordinal'],2)
 def test_no_invented_args_and_no_transform_of_blocked_response(self):
  with tempfile.TemporaryDirectory() as d:
   cfg={'fixture':'/fixture','project':'external','replay':{'actor_id':'a','case_id':'F02','audit_log':str(Path(d)/'replay.jsonl')}};m=SimpleNamespace(filtered_response=lambda msg,req:copy.deepcopy(msg));scoped_proxy.attach_replay(cfg,m);req=self.request();del req['_benchmark_forwarded_arguments']
   with self.assertRaisesRegex(RuntimeError,'forwarded'):m.filtered_response(self.response(),req)
   error={'id':3,'error':{'code':-32001}};self.assertEqual(m.filtered_response(error,self.request()),error)
 def test_cli_without_actor_binding_cannot_consume_replay(self):
  m=SimpleNamespace(filtered_response=lambda msg,req:msg);original=m.filtered_response;scoped_proxy.attach_replay({'project':'external'},m);self.assertIs(m.filtered_response,original)
 def test_unexercised_is_preserved_independent_of_answer(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'audit.jsonl';p.write_text(json.dumps({'status':'unexercised'})+'\n'+json.dumps({'status':'applied'})+'\n');self.assertEqual(run.replay_delivery_status('F02',p)['status'],'FAIL_UNEXERCISED');p.write_text(json.dumps({'status':'applied'})+'\n');self.assertEqual(run.replay_delivery_status('F02',p)['status'],'EXERCISED_UNGRADED');self.assertEqual(run.replay_delivery_status('F01',Path(d)/'absent')['status'],'FAIL_NOT_EXERCISED');self.assertEqual(run.replay_delivery_status('D01',p)['status'],'NOT_APPLICABLE')
 def test_scope_rejects_wrong_project_before_replay_and_never_consumes_ordinal(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);cfg={'fixture':d,'project':'external','collection':'code_fixture','upstream_command':['not-launched'],'upstream_env':{'TEA_RAGS_AUTO_UPDATE':'0'},'audit_log':str(root/'proxy.jsonl'),'forensic_dir':str(root/'private'),'upstream_stderr_log':str(root/'stderr'),'replay':{'actor_id':'a','case_id':'F02','audit_log':str(root/'replay.jsonl')}};(root/'cfg.json').write_text(json.dumps(cfg));_,m=scoped_proxy.configured(root/'cfg.json')
   with self.assertRaises(ValueError):m.guard_call('find_symbol',{'project':'foreign','relativePath':'src/refund-settlement/status.ts'})
   self.assertFalse(Path(cfg['replay']['audit_log']).exists())
 def test_delivery_audit_failure_cannot_deliver_transformed_bytes(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);log=root/'is-directory';log.mkdir();cfg={'fixture':'/fixture','project':'external','replay':{'actor_id':'a','case_id':'F02','audit_log':str(log)}};m=SimpleNamespace(filtered_response=lambda msg,req:copy.deepcopy(msg));scoped_proxy.attach_replay(cfg,m)
   with self.assertRaises(OSError):m.filtered_response(self.response(),self.request())
if __name__=='__main__':unittest.main()
