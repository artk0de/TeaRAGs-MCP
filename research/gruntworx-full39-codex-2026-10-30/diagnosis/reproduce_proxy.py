"""Synthetic offline examples; no server, corpus access or model calls.

These reproduce parser behavior, not the missing original upstream payloads.
Run from this directory: python3 reproduce_proxy.py
"""
import json
from pathlib import Path
import runpy

proxy = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'repro/codex39_mcp_proxy.py'))
filter_response = proxy['filtered_response']
cases = [
    ('projects list', 'list_projects', json.dumps({'projects': []}), AttributeError),
    ('plain text empty graph', 'get_callees', 'No callees found', ValueError),
    ('JSON empty graph', 'get_callees', '{"tree":{"columns":[],"rows":[]}}', None),
]
for label, tool, text, expected in cases:
    response = {'id': 1, 'result': {'content': [{'type': 'text', 'text': text}]}}
    request = {'method': 'tools/call', 'params': {'name': tool}}
    try:
        filter_response(response, request)
    except Exception as error:
        assert expected is not None and isinstance(error, expected), (label, type(error))
        print(label + ': ' + type(error).__name__ + ': ' + str(error))
    else:
        assert expected is None, label
        print(label + ': ACCEPTED')
