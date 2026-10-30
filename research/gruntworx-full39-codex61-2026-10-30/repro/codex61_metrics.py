#!/usr/bin/env python3
"""Offline native app-server metrics. Never opens questions, gold, runner or homes.

Input: one completed/partial run directory containing events.jsonl, marks.json,
status.json and optionally thread-start.json. Output is observational, not a grade.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

TOKEN_FIELDS = ('inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
                'outputTokens', 'reasoningOutputTokens', 'totalTokens')
SEMANTIC = {'semantic_search', 'hybrid_search', 'search_code', 'find_similar', 'rank_chunks'}
SOURCE = {'find_symbol', 'get_callers', 'get_callees', 'trace_path', 'find_cycles',
          'find_co_changed', 'get_architecture_report', 'get_naming_lexicon', 'get_ontology_report'}
METADATA = {'list_projects', 'get_index_status', 'get_index_metrics'}
RESOURCES = {'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates',
             'resources/read', 'resources/list', 'resources/templates/list', 'read_resource'}
TOOL_TYPES = {'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
              'webSearch', 'imageView', 'imageGeneration', 'fileChange', 'sleep'}

def payload_size(item):
    payload = item.get('result')
    if item.get('type') == 'commandExecution':
        payload = item.get('aggregatedOutput')
    elif payload is None:
        payload = item.get('contentItems')
    if payload is None:
        return {'serialized_chars': None, 'serialized_utf8_bytes': None, 'text_chars': None,
                'structured_chars': None}
    serialized = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    structured = None
    text_chars = len(payload) if isinstance(payload, str) else 0
    if isinstance(payload, dict):
        structured = payload.get('structuredContent', payload.get('structured_content'))
        text_chars = sum(len(block.get('text', '')) for block in payload.get('content', [])
                         if isinstance(block, dict) and isinstance(block.get('text'), str))
    return {'serialized_chars': len(serialized), 'serialized_utf8_bytes': len(serialized.encode()),
            'text_chars': text_chars, 'structured_chars': len(json.dumps(structured, ensure_ascii=False,
                separators=(',', ':'))) if structured is not None else None}

def breakdown(value):
    if not isinstance(value, dict):
        return None
    return {key: value.get(key) if isinstance(value.get(key), int) else None for key in TOKEN_FIELDS}

def difference(end, start):
    if end is None or start is None:
        return None
    result = {key: end[key] - start[key] if end[key] is not None and start[key] is not None
              else None for key in TOKEN_FIELDS}
    return None if any(value is not None and value < 0 for value in result.values()) else result

def category(item):
    kind = item.get('type')
    if kind == 'commandExecution':
        return 'shell' if item.get('source', 'agent') != 'userShell' else 'user_shell'
    tool = item.get('tool', '')
    name = tool.rsplit('__', 1)[-1]
    if name in RESOURCES:
        return 'mcp_resource'
    is_tea = 'tea-rags' in item.get('server', '').lower().replace('_', '-') or 'tea-rags' in tool.replace('_', '-')
    if is_tea:
        if name in SEMANTIC:
            return 'tea_semantic'
        if name in SOURCE:
            return 'tea_source_graph'
        if name in METADATA:
            return 'tea_metadata'
        return 'tea_other'
    if kind == 'mcpToolCall':
        return 'other_mcp'
    if kind == 'dynamicToolCall' and name in {'exec', 'js', 'javascript', 'python'}:
        return 'code_mode_wrapper'
    return kind

def collect(events, marks, status, thread_start=None):
    warnings = []
    mark_turns = [mark['turn_id'] for mark in marks]
    if len(set(mark_turns)) != len(mark_turns):
        raise ValueError('Duplicate turn ids in marks')
    if len({mark['id'] for mark in marks}) != len(marks):
        raise ValueError('Duplicate question ids in marks')
    expected = ['Q%02d' % i for i in range(1, len(marks) + 1)]
    if [mark['id'] for mark in marks] != expected:
        raise ValueError('Question marks must retain exact sequential Q01..Q39 order')
    if len(marks) > 39:
        raise ValueError('More than 39 question turns')
    thread_id = status.get('thread_id')
    if not thread_id and thread_start:
        thread_id = thread_start.get('thread', {}).get('id')
    items = {turn: {} for turn in mark_turns}
    usage = {}
    latest_thread_usage = None
    unattributed_usage_indices = []
    turns = {}
    completion_ids = set()
    completed_by_turn = {turn: set() for turn in mark_turns}
    duplicate_completions = 0
    ignored_unmapped = Counter()
    for index, event in enumerate(events):
        method = event.get('method')
        params = event.get('params') or {}
        turn = params.get('turnId') or (params.get('turn') or {}).get('id')
        if thread_id and params.get('threadId') not in (None, thread_id):
            continue
        if method == 'thread/tokenUsage/updated':
            total = breakdown((params.get('tokenUsage') or {}).get('total'))
            if total is not None:
                latest_thread_usage = total
                if turn not in items:
                    unattributed_usage_indices.append(index)
        if turn not in items:
            if method in {'item/completed', 'thread/tokenUsage/updated', 'turn/completed'}:
                ignored_unmapped[method] += 1
            continue
        if method == 'item/completed':
            item = params.get('item') or {}
            if not isinstance(item.get('id'), str):
                warnings.append('Completed item without id at event %d' % index)
                continue
            identity = (params.get('threadId', thread_id), turn, item['id'])
            if identity in completion_ids:
                duplicate_completions += 1
            completion_ids.add(identity)
            completed_by_turn[turn].add(item['id'])
            # A generic output must not replace a richer native call with the same id.
            existing = items[turn].get(item['id'])
            if not existing or item.get('type') != 'functionCallOutput' or existing.get('type') == 'functionCallOutput':
                items[turn][item['id']] = item
        elif method == 'turn/completed':
            turns[turn] = params['turn']
            # The same completed items can appear in the terminal turn snapshot.
            # Fill gaps only; never count the snapshot as a second tool execution.
            for item in params['turn'].get('items', []):
                if isinstance(item.get('id'), str):
                    items[turn].setdefault(item['id'], item)
        elif method == 'thread/tokenUsage/updated':
            value = params.get('tokenUsage') or {}
            total = breakdown(value.get('total'))
            if total is not None:
                usage[turn] = {'total': total, 'last': breakdown(value.get('last')),
                               'event_index': index}
    zero = {key: 0 for key in TOKEN_FIELDS}
    rows = []
    previous_total = zero
    previous_usage_index = -1
    for mark in marks:
        turn_id = mark['turn_id']
        turn = turns.get(turn_id, {})
        snapshot = usage.get(turn_id)
        total = snapshot['total'] if snapshot else None
        delta = difference(total, previous_total)
        if snapshot and any(previous_usage_index < index <= snapshot['event_index'] for index in unattributed_usage_indices):
            delta = None
            warnings.append('%s usage attribution ambiguous due to an unassigned native usage notification' % mark['id'])
        if total is not None and previous_total is not None and delta is None:
            warnings.append('%s cumulative usage decreased; delta unknown' % mark['id'])
        # A missing intermediate snapshot makes both adjacent per-turn deltas unknown.
        previous_total = total
        previous_usage_index = snapshot['event_index'] if snapshot else previous_usage_index
        calls = []
        outputs = []
        messages = []
        for item in items[turn_id].values():
            kind = item.get('type')
            terminal = item.get('status') in {'completed', 'failed', 'declined'}
            if kind in TOOL_TYPES and item.get('status') != 'inProgress' and (item['id'] in completed_by_turn[turn_id] or terminal):
                calls.append({'id': item['id'], 'type': kind, 'category': category(item),
                              'tool': item.get('tool'), 'server': item.get('server'),
                              'status': item.get('status'), 'exit_code': item.get('exitCode'),
                              'source': item.get('source'), 'duration_ms': item.get('durationMs'),
                              'result_size': payload_size(item)})
            elif kind == 'functionCallOutput':
                outputs.append({'id': item['id'], 'name': item.get('name'), 'namespace': item.get('namespace')})
            elif kind == 'agentMessage':
                messages.append({'id': item['id'], 'phase': item.get('phase'), 'text': item.get('text', '')})
        final = [message for message in messages if message['phase'] == 'final_answer']
        phase_unknown = False
        if not final:
            unknown = [message for message in messages if message['phase'] is None]
            final = unknown[-1:]
            phase_unknown = bool(final)
        counts = Counter(call['category'] for call in calls)
        rows.append({**mark, 'native_turn_status': turn.get('status'),
                     'native_turn_duration_ms': turn.get('durationMs'),
                     'usage_delta': delta, 'usage_cumulative': total,
                     'usage_last_response_only': snapshot['last'] if snapshot else None,
                     'completed_tool_calls': calls, 'tool_counts': dict(counts),
                     'tool_completed_unique': sum(value for key, value in counts.items() if key != 'user_shell'),
                     'tool_counts_complete': not outputs and not counts.get('code_mode_wrapper', 0),
                     'unattributed_function_outputs': outputs,
                     'nested_code_mode_counts_complete': False if counts.get('code_mode_wrapper') or outputs else None,
                     'agent_messages': messages, 'final_answer': '\n\n'.join(message['text'] for message in final),
                     'final_answer_phase_unknown': phase_unknown})
    marked_total = usage.get(mark_turns[-1], {}).get('total') if mark_turns else None
    final_total = latest_thread_usage if status.get('valid') is True and (marked_total is not None or unattributed_usage_indices) else None
    q01_total = usage.get(mark_turns[0], {}).get('total') if mark_turns else None
    aggregate_counts = Counter()
    excluded_counts = Counter()
    for row in rows:
        aggregate_counts.update(row['tool_counts'])
        if row['id'] != 'Q01':
            excluded_counts.update(row['tool_counts'])
    native_completed = sum(row['native_turn_status'] == 'completed' for row in rows)
    if native_completed != len(marks):
        warnings.append('Runner marks and native completed turns differ; event trace is incomplete or a turn failed')
    return {'schema_version': 1,
            'contract': {'tool_count': 'Unique native completed item ids; failed/declined lifecycle ends retained by status; started/deltas/text mentions never counted',
                         'usage': 'Latest cumulative total at each turn minus preceding question total, never sum cumulative updates or add cached/reasoning subsets',
                         'missing_usage': 'null means unavailable, never zero',
                         'nested_calls': 'Only native completed item evidence; wrapper source strings are not evidence of nested execution',
                         'grading': 'Metrics are not correctness grades; assess direct user intent and historical gold separately after final; no penalty for using held context without tools'},
            'cell': status.get('cell'), 'thread_id': thread_id,
            'run_state': 'completed' if status.get('valid') is True else status.get('state', 'failed' if status.get('valid') is False else 'in_progress'),
            'question_turn_unit': 'Native app-server question turns, not underlying model responses/assistant iterations',
            'underlying_model_response_count': None,
            'completed_questions': len(marks), 'native_completed_questions': native_completed,
            'runner_complete_39': len(marks) == 39 and status.get('valid') is True,
            'complete_39': len(marks) == 39 and native_completed == 39 and status.get('valid') is True,
            'full_wall_seconds': status.get('wall_seconds'),
            'full_wall_scope': 'Runner session clock after RPC initialization; excludes app-server startup/initialize and teardown',
            'sum_question_wall_seconds': round(sum(row['wall_seconds'] for row in rows), 3),
            'sum_question_wall_seconds_excluding_q01': round(sum(row['wall_seconds'] for row in rows if row['id'] != 'Q01'), 3),
            'usage_total': final_total, 'usage_total_excluding_q01': difference(final_total, q01_total),
            'usage_latest_thread_total': latest_thread_usage, 'usage_marked_completed_questions_total': marked_total,
            'token_subset_semantics': 'cachedInputTokens is a subset of inputTokens; reasoningOutputTokens is a subset of outputTokens',
            'new_input_tokens': final_total['inputTokens'] - final_total['cachedInputTokens'] if final_total and final_total['inputTokens'] is not None and final_total['cachedInputTokens'] is not None else None,
            'non_reasoning_output_tokens': final_total['outputTokens'] - final_total['reasoningOutputTokens'] if final_total and final_total['outputTokens'] is not None and final_total['reasoningOutputTokens'] is not None else None,
            'tool_counts': dict(aggregate_counts),
            'tool_counts_excluding_q01': dict(excluded_counts),
            'tool_completed_unique': sum(row['tool_completed_unique'] for row in rows),
            'tool_completed_unique_excluding_q01': sum(row['tool_completed_unique'] for row in rows if row['id'] != 'Q01'),
            'tool_counts_complete': all(row['tool_counts_complete'] for row in rows),
            'per_question': rows,
            'diagnostics': {'duplicate_native_completion_events': duplicate_completions,
                            'ignored_unmapped_events': dict(ignored_unmapped), 'warnings': warnings}}

def parse_run(directory):
    root = Path(directory)
    events = []
    bad_lines = []
    with (root / 'events.jsonl').open() as source:
        for number, line in enumerate(source, 1):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                bad_lines.append(number)
    marks_file = root / 'marks.json'
    marks = json.loads(marks_file.read_text()) if marks_file.exists() else []
    status_file = root / 'status.json'
    status = json.loads(status_file.read_text()) if status_file.exists() else {
        'state': 'in_progress', 'valid': None, 'cell': root.name, 'wall_seconds': None}
    start_file = root / 'thread-start.json'
    start = json.loads(start_file.read_text()) if start_file.exists() else None
    result = collect(events, marks, status, start)
    result['diagnostics']['invalid_event_json_lines'] = bad_lines
    result['collector_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    result['source_sha256'] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                               for name in ('events.jsonl', 'marks.json', 'status.json') if (root / name).exists()}
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_directory')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    text = json.dumps(parse_run(args.run_directory), ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text + '\n')
    else:
        print(text)

if __name__ == '__main__':
    main()
