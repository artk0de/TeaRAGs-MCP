import unittest
from policy import tool_decision


class ReadonlyResourceDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.scope = {'fixture': '/fixture', 'plugin_root': '/plugin'}

    def test_readonly_resource_adapter_metadata_is_discoverable(self):
        for name in ['ReadMcpResourceTool', 'ListMcpResourcesTool']:
            with self.subTest(name=name):
                result = tool_decision('ToolSearch', {'query': 'select:' + name}, self.scope)
                self.assertTrue(result['allow'], result)

    def test_select_cannot_hide_a_code_running_builtin_beside_a_readonly_mcp_tool(self):
        result = tool_decision('ToolSearch', {
            'query': 'select:Bash,mcp__tea-rags__find_symbol',
        }, self.scope)
        self.assertFalse(result['allow'], result)

    def test_resource_execution_remains_scoped_to_the_fixture_server(self):
        result = tool_decision('ReadMcpResourceTool', {
            'server': 'foreign', 'uri': 'tea-rags://guide/freshness',
        }, self.scope)
        self.assertFalse(result['allow'], result)

    def test_mutator_discovery_is_still_rejected(self):
        result = tool_decision('ToolSearch', {
            'query': 'select:ReadMcpResourceTool,mcp__tea-rags__index_codebase',
        }, self.scope)
        self.assertFalse(result['allow'], result)


if __name__ == '__main__':
    unittest.main()
