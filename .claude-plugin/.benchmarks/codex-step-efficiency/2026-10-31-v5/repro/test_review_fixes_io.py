"""Regression checks from independent review; subprocesses are offline fakes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from controller_io import runtime_identity

HERE=Path(__file__).resolve().parent
PROBE=r'''
import json,sys,types
from pathlib import Path
from unittest import mock
from controller_io import runtime_identity,verify_runtime
case=Path(sys.argv[1]);entry=sys.argv[2];marker=case/'rpc-created';fresh=case/'output'
# Deliberately freeze the same optimized identity: identity equality alone is insufficient.
identity=runtime_identity()
def rpc_reached(*args,**kwargs):
 marker.write_text('offline fake only')
 fresh.mkdir(exist_ok=True)
 raise RuntimeError('offline fake RPC reached')
try:
 if entry=='verify_runtime':
  verify_runtime(identity);rpc_reached()
 elif entry=='prepare':
  import prepare
  source=case/'source';source.mkdir();baseline=case/'baseline';baseline.mkdir()
  (baseline/'final-manifest.json').write_text(json.dumps({'corpus_commit':'fixture-head'}))
  def git(command,**kwargs):
   return '' if 'status' in command else 'fixture-head\n'
  with mock.patch.object(prepare.subprocess,'check_output',side_effect=git),mock.patch.object(prepare,'copy_modules',side_effect=rpc_reached),mock.patch.object(sys,'argv',['prepare.py','--source',str(source),'--base',str(fresh),'--baseline',str(baseline)]):
   prepare.main()
 elif entry=='run':
  import run
  base=case/'prepared';base.mkdir()
  manifest={'ROOTGO':False,'controller_python':identity,'order':['A'],'runs_authorized':['A'],'runs_per_condition':1,'model':'gpt-6.1-sol','effort':'medium','prepared_model_turns':0,'preflight_ready':True,'frozen_files':{}}
  (base/'final-manifest.json').write_text(json.dumps(manifest))
  for name in ['independent-review.json','focused-cases.json','transport-preservation.json']:
   (base/name).write_text(json.dumps({'verdict':'PASS','frozen_files_sha256':run.fingerprint({})}))
  fake=types.ModuleType('codex61_runner');fake.configure=lambda *a:None;fake.verify_frozen=lambda *a:None;fake.execute=rpc_reached
  with mock.patch.dict(sys.modules,{'codex61_runner':fake}),mock.patch.object(sys,'argv',['run.py','--base',str(base),'--rootgo']):
   run.main()
 elif entry=='job':
  import job
  base=case/'prepared';base.mkdir();(base/'final-manifest.json').write_text(json.dumps({'controller_python':identity}))
  with mock.patch.object(job.subprocess,'run',side_effect=rpc_reached),mock.patch.object(sys,'argv',['job.py','--base',str(base)]):
   job.main()
except RuntimeError as error:
 print(str(error));raise SystemExit(64)
'''

class ReviewRegressionTests(unittest.TestCase):
    def test_optimized_python_refused_before_rpc_or_outputs(self):
        for mode in ('argument','environment'):
            for entry in ('prepare','run','job','verify_runtime'):
                with self.subTest(mode=mode,entry=entry),tempfile.TemporaryDirectory() as d:
                    env=os.environ.copy();env.pop('PYTHONOPTIMIZE',None)
                    command=[sys.executable]
                    if mode=='argument':command.append('-O')
                    else:env['PYTHONOPTIMIZE']='1'
                    result=subprocess.run(command+['-c',PROBE,d,entry],cwd=HERE,env=env,capture_output=True,text=True)
                    self.assertEqual(result.returncode,64,result.stderr)
                    self.assertIn('optimized',result.stdout.lower())
                    folder=Path(d)
                    self.assertFalse((folder/'rpc-created').exists())
                    self.assertFalse((folder/'output').exists())
                    self.assertFalse((folder/'prepared/ROOTGO.json').exists())
                    self.assertFalse((folder/'prepared/root-job-status.json').exists())
                    self.assertFalse((folder/'prepared/runs').exists())

    def test_collector_nonzero_is_propagated_and_accounting_failed_is_retained(self):
        spec=importlib.util.spec_from_file_location('offline_job',HERE/'job.py')
        job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);(base/'final-manifest.json').write_text(json.dumps({'controller_python':runtime_identity()}))
            replies=[subprocess.CompletedProcess([],0),subprocess.CompletedProcess([],17)]
            with mock.patch.object(job.subprocess,'run',side_effect=replies) as calls,mock.patch.object(sys,'argv',['job.py','--base',d]):
                code=job.main()
            self.assertEqual(code,17)
            self.assertEqual(calls.call_count,2)
            status=json.loads((base/'root-job-status.json').read_text())
            self.assertEqual(status['status'],'accounting_failed')
            self.assertEqual(status['actor_returncode'],0)
            self.assertEqual(status['collector_returncode'],17)

if __name__=='__main__':unittest.main()
