import unittest,json,tempfile,pathlib,ast
from persistence_replay import inventory,dump,BASE,ROOT,runner
class PersistenceTests(unittest.TestCase):
 def test_exact_prefix_byte_formula(self):
  events=[{'method':'visible','params':{'delta':'Привет 🦖'}},{'method':'x','params':{'items':[{'k':'v\nx'}]}},{'method':'last','params':None}]
  actual=sum(len((json.dumps(events[:n],ensure_ascii=False,indent=2)+'\n').encode()) for n in range(1,len(events)+1))
  self.assertEqual(inventory(events)['cumulative_bytes_rewritten'],actual)
 def test_frozen_dump_fidelity_and_no_input_mutation(self):
  events=[{'method':'x','params':{'delta':'é'}}];before=json.dumps(events)
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'p.json';dump(p,events);self.assertEqual(p.read_bytes(),(json.dumps(events,ensure_ascii=False,indent=2)+'\n').encode())
  self.assertEqual(json.dumps(events),before)
 def test_all_frozen_dump_functions_equal(self):
  def body(p):return ast.dump(next(n for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='dump'),include_attributes=False)
  expected=body(runner)
  for run in BASE['runs'].values():self.assertEqual(body(ROOT/run['source'].split('/runs/')[0]/'lib/codex61_runner.py'),expected)
if __name__=='__main__':unittest.main()
