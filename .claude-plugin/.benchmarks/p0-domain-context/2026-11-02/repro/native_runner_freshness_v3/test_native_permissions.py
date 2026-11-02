"""Native child argv is the permission boundary; no CLI/model process started."""
import tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
import claude_native,policy
class NativePermissionsTests(unittest.TestCase):
 def test_child_launch_exact_readonly_mcp_names_and_other_guards_retained(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);profile={'guard':{'fixture':str(p/'fixture'),'plugin_root':str(p/'plugin')},'skills':{},'plugin_inventory':{},'claude_config':str(p/'fresh-config'),'os_home':str(p/'fresh-home'),'launch_env':{'PATH':'/usr/bin:/bin'},'claude_cli':'/native-claude','mcp_config':str(p/'mcp.json'),'model':'claude-sonnet-5-5','effort':'medium'};child=MagicMock()
   with patch.object(claude_native.subprocess,'Popen',return_value=child) as launch,patch.object(claude_native.threading,'Thread'),patch.object(claude_native,'load_claude_auth',return_value={}):
    client=claude_native.ClaudeNative(profile,p/'out',False)
    try:
     argv=launch.call_args.args[0];self.assertIn('--allowedTools',argv);actual=argv[argv.index('--allowedTools')+1].split(',');self.assertEqual(set(actual),{'mcp__tea-rags__'+name for name in policy.READ_TOOLS});self.assertEqual(len(actual),17);self.assertFalse(any('*' in name for name in actual));self.assertNotIn('Bash',actual);self.assertNotIn('mcp__tea-rags__index_codebase',actual);self.assertNotIn('--dangerously-skip-permissions',argv);self.assertIn('--restricted',argv);self.assertIn('--strict-mcp-config',argv);self.assertEqual(argv[argv.index('--permission-mode')+1],'dontAsk')
    finally:client.close()
 def test_native_allow_does_not_weaken_scoped_pretool_denials(self):
  cfg={'fixture':'/fixture','plugin_root':'/plugin','project':'fixture','collection':'code_fixture','skill_names':[]}
  self.assertTrue(policy.tool_decision('mcp__tea-rags__find_symbol',{'project':'fixture','path':'/fixture','relativePath':'source.ts'},cfg)['allow'])
  for name,args in [('mcp__foreign__find_symbol',{}),('mcp__tea-rags__index_codebase',{}),('mcp__tea-rags__find_symbol',{'project':'foreign'}),('mcp__tea-rags__find_symbol',{'relativePath':'../grading.json'}),('Bash',{'command':'cat /outside'})]:
   with self.subTest(name=name,args=args):self.assertFalse(policy.tool_decision(name,args,cfg)['allow'])
if __name__=='__main__':unittest.main()
