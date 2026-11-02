"""Public native result, not catalog metadata, must establish actual tool execution."""
import unittest
import selected12
class ExecutionGateTests(unittest.TestCase):
 def events(self):return [{'type':'assistant','message':{'content':[{'type':'tool_use','id':'actual','name':'mcp__tea-rags__find_symbol','input':{'relativePath':'src/refund-settlement/status.ts','project':'external','path':'/fixture'}}]}},{'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'actual','content':'real source: refund_settlement','is_error':False}]}}]
 def test_actual_tool_result_and_transformed_delivery_required(self):
  got=selected12.check_native_execution(self.events(),[{'status':'applied','forwarded_locators':{'project':'external','path':'/fixture'}}],{'project':'external','fixture':'/fixture'});self.assertEqual(got['successful_target_tool_ids'],['actual'])
 def test_catalog_read_fallback_missing_reply_and_mode_denial_cannot_pass(self):
  events=self.events();scope={'project':'external','fixture':'/fixture'};audit=[{'status':'applied','forwarded_locators':scope}]
  for e,a in [([{'type':'system','subtype':'init','tools':['mcp__tea-rags__find_symbol']}],audit),(events[:1],audit),(events,[]),(events+[{'type':'system','subtype':'permission_denied','decision_reason_type':'mode','tool_name':'mcp__tea-rags__find_symbol'}],audit)]:
   with self.subTest(events=e),self.assertRaises(RuntimeError):selected12.check_native_execution(e,a,scope)
 def test_exact_selected12_excludes_old_baseline_codex_and_requires_first_gate_order(self):
  self.assertEqual(len(selected12.KEYS),12);self.assertEqual(selected12.KEYS[0],'baseline-claude-F01');self.assertFalse(any(k.startswith('baseline-codex-') for k in selected12.KEYS))
  with self.assertRaises(PermissionError):selected12.check_selected(list(reversed(selected12.KEYS)))
if __name__=='__main__':unittest.main()
