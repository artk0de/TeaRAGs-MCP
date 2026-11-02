"""Fail-closed native MCP readiness in the exact RPC/thread used for a turn.

No model requests, sleeps, background polling or synthetic tool inventory. Native
notifications remain in rpc.pending for the existing protocol observer. Runtime
readiness does not by itself prove code-mode ALL_TOOLS projection/snapshot timing.
"""
import queue
import time


def wait_for_mcp_ready(rpc, thread_id, expected_tools, timeout=120):
    expected = set(expected_tools)
    if not thread_id or len(expected) != 17:
        raise RuntimeError('MCP inventory contract requires a thread and exactly 17 expected real tools')
    started = time.monotonic()
    deadline = started + timeout
    params = {'threadId': thread_id, 'serverName': 'tea-rags',
              'detail': 'toolsAndAuthOnly', 'limit': 100}
    queries = 0

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError('Same-thread MCP readiness deadline; no model turn started')
        return value

    def inventory():
        nonlocal queries
        response = rpc.call('mcpServerStatus/list', params, timeout=remaining())
        queries += 1
        rows = response.get('data', [])
        if response.get('nextCursor') or len(rows) != 1 or rows[0].get('name') != 'tea-rags':
            raise RuntimeError('MCP inventory missing, ambiguous or paginated; no model turn started')
        server = rows[0]
        state = server.get('runtimeStatus')
        if server.get('toolsError'):
            raise RuntimeError('MCP inventory discovery failed: ' + str(server['toolsError']))
        if state == 'connected':
            tools = server.get('tools')
            if not isinstance(tools, dict) or set(tools) != expected:
                raise RuntimeError('MCP inventory differs from the exact 17 frozen real tools')
            return {'thread_id': thread_id, 'inventory': response, 'model_turns': 0,
                    'status_queries': queries, 'wall_seconds': time.monotonic() - started,
                    'limitation': 'Same-thread runtime/inventory ready; code-mode ALL_TOOLS projection requires a separate model observation'}
        if state not in ('notStarted', 'starting'):
            raise RuntimeError('MCP startup state ' + str(state) + '; no model turn started')
        return None

    result = inventory()
    if result is not None:
        return result
    cursor = 0
    while True:
        while cursor < len(rpc.pending):
            event = rpc.pending[cursor]
            cursor += 1
            params_event = event.get('params') or {}
            if (event.get('method') != 'mcpServer/startupStatus/updated'
                    or params_event.get('threadId') != thread_id
                    or params_event.get('name') != 'tea-rags'):
                continue
            state = params_event.get('status')
            if state in ('failed', 'cancelled'):
                raise RuntimeError('MCP startup ' + state + ': ' + str(params_event.get('error')))
            if state == 'ready':
                result = inventory()
                if result is None:
                    raise RuntimeError('MCP ready event did not establish connected inventory')
                return result
        try:
            event = rpc.next(timeout=remaining())
        except queue.Empty as error:
            raise TimeoutError('Same-thread MCP readiness deadline; no model turn started') from error
        rpc.pending.append(event)
