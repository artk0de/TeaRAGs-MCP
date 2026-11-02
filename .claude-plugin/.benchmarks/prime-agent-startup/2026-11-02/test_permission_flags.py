"""Pure actual-command AST and existing guard checks; no CLI/native/model spawn."""
import ast,sys,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'controller'))
from policy import READ_TOOLS,tool_decision

class PermissionFlags(unittest.TestCase):
 def command(self):
  tree=ast.parse((ROOT/'controller/claude_native.py').read_text())
  node=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='cmd' for t in n.targets))
  profile={k:'fixture-'+k for k in ['claude_cli','mcp_config','model','effort']}
  return eval(compile(ast.Expression(node.value),'<actual-reviewed-command>','eval'),{'sorted':sorted,'READ_TOOLS':READ_TOOLS,'profile':profile,'self':SimpleNamespace(guard={'plugin_root':'fixture-plugin'})})
 def test_actual_native_command_allows_exact17_and_keeps_dontask(self):
  cmd=self.command();self.assertEqual(cmd.count('--allowedTools'),1)
  names=cmd[cmd.index('--allowedTools')+1].split(',')
  self.assertEqual(names,['mcp__tea-rags__'+n for n in sorted(READ_TOOLS)])
  self.assertEqual(len(names),17);self.assertFalse(any('*' in n for n in names))
  self.assertEqual(cmd[cmd.index('--permission-mode')+1],'dontAsk')
 def test_write_and_outside_project_still_denied_by_same_transport_guard(self):
  cfg={'fixture':'/Users/Shared/nav-ab/p0-context-eval-ng1ni','project':'p0-context-eval-ng1ni','collection':'code_540fd38f','plugin_root':'/not-a-plugin','skill_names':[]}
  for name,args in [('mcp__tea-rags__delete_collection',{}),('mcp__tea-rags__find_symbol',{'project':cfg['project'],'path':'/etc','symbol':'X'})]:
   self.assertIs(tool_decision(name,args,cfg)['allow'],False)

if __name__=='__main__':unittest.main()
