import tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import selected4 as s

class SelectionTests(unittest.TestCase):
 def test_baseline_is_rejected_before_native_delegate(self):
  with patch.object(s,'selection',return_value=({},s.KEYS)),patch.object(s,'load',return_value={}),patch.object(s.run,'run_one') as invoke:
   with self.assertRaisesRegex(PermissionError,'forbidden'):s.run_key('/tmp/not-live','baseline-codex-C01','unused',False)
   invoke.assert_not_called()
 def test_only_candidate_four_selected_from_canonical_eight(self):
  cases={'cases':[{'id':'C01','prompt':'one'},{'id':'C02','prompt':'two'}]}
  history={'never_rerun':True,'rows':[{'key':key,'artifacts_sha256':{}} for key in s.KEYS]}
  with patch.object(s,'load',side_effect=[{'cases_path':'cases'},cases,history]):
   _,keys=s.selection(Path('/tmp/not-live'))
  self.assertEqual(keys,s.KEYS)
 def test_duplicate_historical_binding_rejected(self):
  cases={'cases':[{'id':'C01','prompt':'one'},{'id':'C02','prompt':'two'}]}
  history={'never_rerun':True,'rows':[{'key':s.KEYS[0],'artifacts_sha256':{}}]*4}
  with patch.object(s,'load',side_effect=[{'cases_path':'cases'},cases,history]):
   with self.assertRaisesRegex(RuntimeError,'binding'):s.selection('/tmp/not-live')
 def test_failure_stops_schedule_without_retry(self):
  calls=[]
  def fail(out,key,go,native):calls.append(key);raise RuntimeError('retained failure')
  with tempfile.TemporaryDirectory() as d,patch.object(s,'verify',return_value=s.KEYS),patch.object(s,'run_key',side_effect=fail):
   go=Path(d)/'go.json';go.write_text('{}')
   with self.assertRaisesRegex(RuntimeError,'retained'):s.execute(d,go,False)
   self.assertTrue((Path(d)/'SELECTED4-RUN-STOP.json').is_file())
   self.assertEqual(calls,[s.KEYS[0]])
 def test_unreleased_window_blocks_metadata(self):
  seal={};controller={k:'d' for k in ['adapter_sha256','tests_sha256','canonical_seal_sha256','historical_baseline_sha256','postcommit_manifest_sha256']};controller.update({'selected_keys':s.KEYS,'execute_actor_count':4})
  go={**controller,'ROOT_NATIVE_GO':True,'keys':s.KEYS,'seal_sha256':'d','selected4_seal_sha256':'d'}
  review={'status':'PASS','selected4_seal_sha256':'d'}
  with patch.object(s,'selection',return_value=(seal,s.KEYS)),patch.object(s,'sha',return_value='d'),patch.object(s,'load',side_effect=[controller,go,review,{'early16_terminal':False,'release_for_startup4':False}]):
   with self.assertRaisesRegex(PermissionError,'window'):s.verify('/tmp/not-live','unused',True,s.KEYS[0])

if __name__=='__main__':unittest.main()
