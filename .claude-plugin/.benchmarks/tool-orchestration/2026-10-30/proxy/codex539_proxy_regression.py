"""Regression for a legitimate Q02 noEdges banner; no model/corpus access."""
import json
from pathlib import Path
import codex539_mcp_proxy as proxy

checks = []
for tool, noun in [('get_callers', 'callers'), ('get_callees', 'callees')]:
    for symbol in ['TaxPreparation::Mock::Adapter#call', 'Foo::bar?', 'Foo.bar']:
        short = symbol.replace('::', '.').replace('#', '.').split('.')[-1]
        banner = f'↳ Empty ≠ no {noun}: dynamic/DSL/job call sites are not in the graph — default code search tool "{short}" <src dir> (literal, -l) before concluding.'
        request = {'method': 'tools/call', 'params': {'name': tool, 'arguments': {'symbolId': symbol}}}
        upstream = {'result': {'content': [{'type': 'text', 'text': banner}, {'type': 'text', 'text': json.dumps({'empty': {'reason': 'noEdges'}, 'tree': []})}]}}
        received = proxy.filtered_response(upstream, request)
        assert received['result']['content'][0]['text'] == banner
        checks.append(tool + ':' + symbol)
        for bad in [banner + '\nCANARY', banner.replace('"' + short + '"', '"foreign"'), banner.replace('no ' + noun, 'no ' + ('callees' if noun == 'callers' else 'callers'))]:
            try:
                proxy.parse_tool_text(bad, tool, request['params']['arguments'])
            except ValueError:
                checks.append('reject:' + bad[-20:])
            else:
                raise AssertionError('Untrusted or mismatched banner crossed')
        try:
            proxy.parse_tool_text(banner, 'find_symbol', {'symbol': symbol})
        except ValueError:
            checks.append('reject:non-graph')
        else:
            raise AssertionError('Graph banner accepted for non-graph tool')
out = Path(__file__).with_suffix('.json')
out.write_text(json.dumps({'passed': len(checks), 'checks': checks}, indent=2) + '\n')
print('PASS', len(checks), 'banner checks')
