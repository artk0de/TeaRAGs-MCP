#!/usr/bin/env python3
"""Offline metric extraction; never starts an actor or estimates hidden tokens."""
import argparse
import json
from decimal import Decimal
from pathlib import Path

FIELDS = ('totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
          'outputTokens', 'reasoningOutputTokens')


def extract(directory):
    actor = Path(directory) / 'actor'
    status = json.loads((actor / 'status.json').read_text())
    turn_id = status.get('turn_id')
    responses, updates, completed, compactions, issues, native_items, raw_finals = {}, [], [], [], [], {}, {}
    turn_starts, hook_starts, hook_ends = 0, 0, 0
    for number, line in enumerate((actor / 'events.jsonl').open(), 1):
        event = json.loads(line)
        method, params = event.get('method', ''), event.get('params', {})
        turn_starts += method == 'turn/started'
        hook_starts += method == 'hook/started'
        hook_ends += method == 'hook/completed'
        if 'compact' in method.lower() or 'compact' in params.get('item', {}).get('type', '').lower():
            compactions.append({'line': number, 'method': method})
        if params.get('turnId', turn_id) != turn_id:
            if method in ('rawResponse/completed', 'thread/tokenUsage/updated'):
                issues.append('usage event outside recorded turn scope at line ' + str(number))
            continue
        if method == 'rawResponse/completed':
            response_id, usage = params.get('responseId'), params.get('usage')
            if not response_id or not isinstance(usage, dict):
                issues.append('missing responseId/usage at line ' + str(number))
                continue
            if response_id in responses and responses[response_id]['usage'] != usage:
                issues.append('conflicting duplicate response ' + response_id)
            responses.setdefault(response_id, {'line': number, 'usage': usage})
        elif method == 'thread/tokenUsage/updated':
            updates.append({'line': number, 'usage': params.get('tokenUsage', {})})
        elif method == 'turn/completed' and params.get('turn', {}).get('id') == turn_id:
            completed.append(params['turn'])
        elif method == 'item/completed':
            item = params.get('item', {})
            native_items[item.get('id', str(number))] = item
        elif method == 'rawResponseItem/completed':
            item = params.get('item', {})
            if item.get('type') == 'message' and item.get('role') == 'assistant' and item.get('phase') == 'final_answer':
                raw_finals[item.get('id', str(number))] = '\n'.join(
                    part.get('text', '') for part in item.get('content', []) if part.get('type') == 'output_text')
    if not responses:
        issues.append('no raw response usage')
    if len(completed) != 1 or completed[0].get('status') != 'completed':
        issues.append('missing unique successful turn/completed')
    if not status.get('valid'):
        issues.append('actor status invalid')
    if turn_starts != 1 or status.get('attempt') != 1:
        issues.append('not exactly one recorded native turn on attempt one')
    thread_start = json.loads((actor / 'thread-start.json').read_text())
    if thread_start.get('model') != 'gpt-6.1-sol' or thread_start.get('reasoningEffort') != 'medium':
        issues.append('actual model/effort differs from preregistration')
    for response_id, row in responses.items():
        if any(not isinstance(row['usage'].get(key), int) for key in FIELDS):
            issues.append('incomplete/noninteger usage in ' + response_id)
    summed = {key: sum(row['usage'].get(key, 0) for row in responses.values()) for key in FIELDS}
    thread_total = updates[-1]['usage'].get('total', {}) if updates else {}
    mismatches = {key: {'raw_sum': summed[key], 'thread_total': thread_total.get(key)}
                  for key in FIELDS if summed[key] != thread_total.get(key)}
    if mismatches:
        issues.append('raw sum differs from final thread totals')
    if compactions:
        issues.append('compaction observed; simple fresh-thread scope invalid')
    def final_messages(turns):
        messages = {}
        for turn in turns:
            if turn.get('id') != turn_id:
                continue
            for item in turn.get('items', []):
                if item.get('type') == 'agentMessage' and item.get('phase') == 'final_answer':
                    messages[item.get('id', str(len(messages)))] = item.get('text', '')
        return '\n\n'.join(messages.values())
    completed_final = final_messages(completed)
    raw_final = '\n\n'.join(raw_finals.values())
    thread_state = json.loads((actor / 'thread-read.json').read_text())
    thread_final = final_messages(thread_state.get('thread', {}).get('turns', []))
    final_sources = {'turn_completed': completed_final, 'raw_final_items': raw_final, 'thread_read': thread_final}
    available_finals = [text for text in final_sources.values() if text]
    final = available_finals[0] if available_finals else ''
    if not final:
        issues.append('no observable final answer text')
    elif any(text != final for text in available_finals):
        issues.append('final answer text differs across native sources')
    return {'directory': str(directory), 'turn_id': turn_id, 'valid': not issues,
            'issues': issues, 'usage': summed, 'responses': responses,
            'thread_total': thread_total, 'scope_mismatches': mismatches,
            'compactions': compactions, 'response_count': len(responses),
            'turn_started_count': turn_starts, 'attempt': status.get('attempt'),
            'hook_started_count': hook_starts, 'hook_completed_count': hook_ends,
            'actual_model': thread_start.get('model'), 'actual_effort': thread_start.get('reasoningEffort'),
            'final_answer_sources_present': [key for key, text in final_sources.items() if text],
            'final_answer_sources_match': len(set(available_finals)) <= 1,
            'final_answer_word_count': len(final.split()), 'final_answer_characters': len(final),
            'word_count_method': 'Whitespace-separated words in native final-answer text, including markdown',
            'native_tool_counts': {kind: sum(i.get('type') == kind for i in native_items.values())
                                   for kind in ('commandExecution', 'mcpToolCall', 'dynamicToolCall')},
            'native_turn_duration_ms': completed[0].get('durationMs') if completed else None,
            'controller_wall_seconds': status.get('wall_seconds')}


def reduction(control, candidate):
    return None if control == 0 else (control - candidate) / control


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--quality', help='Reviewer JSON: cases keyed as arm:manifest-key, each with pass boolean')
    parser.add_argument('--min-control-reasoning', type=int, default=500)
    parser.add_argument('--min-nonzero-pairs', type=int, default=3)
    args = parser.parse_args()
    run = Path(args.run)
    manifest = json.loads((run / 'manifest.json').read_text())
    if manifest.get('model') != 'gpt-6.1-sol' or manifest.get('effort') != 'medium':
        raise ValueError('Manifest model/effort differs from preregistration')
    quality = json.loads(Path(args.quality).read_text()).get('cases', {}) if args.quality else {}
    cases, pairs = {}, {}
    for meta in manifest['cases']:
        manifest_key = meta['key']
        pair_id = str(meta.get('pair_id', meta.get('base_key', meta.get('case_key', manifest_key))))
        arm = meta.get('arm')
        if arm not in ('control', 'candidate'):
            raise ValueError('Case requires explicit control/candidate arm: ' + manifest_key)
        key = arm + ':' + manifest_key
        cases[key] = dict(extract(meta['directory']), pair_id=pair_id, arm=arm,
                          quality=quality.get(key))
        if arm in pairs.setdefault(pair_id, {}):
            raise ValueError('Duplicate arm in pair: ' + pair_id)
        pairs[pair_id][arm] = key
    comparisons = []
    for pair_id, arms in pairs.items():
        if set(arms) != {'control', 'candidate'}:
            raise ValueError('Incomplete pair: ' + pair_id)
        control, candidate = (cases[arms[arm]] for arm in ('control', 'candidate'))
        comparisons.append({'pair_id': pair_id, 'arms': arms,
            'valid': control['valid'] and candidate['valid'],
            'reasoning_control': control['usage']['reasoningOutputTokens'],
            'reasoning_candidate': candidate['usage']['reasoningOutputTokens'],
            'reasoning_reduction': reduction(control['usage']['reasoningOutputTokens'], candidate['usage']['reasoningOutputTokens']),
            'output_control': control['usage']['outputTokens'], 'output_candidate': candidate['usage']['outputTokens'],
            'native_duration_control_ms': control['native_turn_duration_ms'],
            'native_duration_candidate_ms': candidate['native_turn_duration_ms']})
    control_sum = sum(p['reasoning_control'] for p in comparisons)
    candidate_sum = sum(p['reasoning_candidate'] for p in comparisons)
    eligible = [p for p in comparisons if p['reasoning_control'] > 0]
    reductions = sum(p['reasoning_candidate'] < p['reasoning_control'] for p in eligible)
    all_valid = all(p['valid'] for p in comparisons)
    if len(comparisons) != 8 or len(cases) != 16:
        all_valid = False
    quality_complete = all(isinstance(c.get('quality'), dict) and isinstance(c['quality'].get('pass'), bool) for c in cases.values())
    control_quality_pass = quality_complete and all(c['quality']['pass'] for c in cases.values() if c['arm'] == 'control')
    candidate_quality_pass = quality_complete and all(c['quality']['pass'] for c in cases.values() if c['arm'] == 'candidate')
    quality_nonregression = quality_complete and all(c['quality']['pass'] for c in cases.values())
    low_baseline = control_sum < args.min_control_reasoning or len(eligible) < args.min_nonzero_pairs
    aggregate = reduction(control_sum, candidate_sum)
    majority = reductions > len(eligible) / 2
    output_totals = {arm: sum(c['usage']['outputTokens'] for c in cases.values() if c['arm'] == arm)
                     for arm in ('control', 'candidate')}
    native_ms = {arm: sum(c['native_turn_duration_ms'] or 0 for c in cases.values() if c['arm'] == arm)
                 for arm in ('control', 'candidate')}
    controller_ms = {arm: int(sum(Decimal(str(c['controller_wall_seconds'] or 0)) * 1000
                         for c in cases.values() if c['arm'] == arm)) for arm in ('control', 'candidate')}
    if not all_valid:
        decision = 'INCONCLUSIVE_SCOPE_OR_RUNTIME'
    elif not quality_complete:
        decision = 'PENDING_QUALITY_REVIEW'
    elif not control_quality_pass:
        decision = 'INCONCLUSIVE_CONTROL_QUALITY_FAILURE'
    elif not candidate_quality_pass:
        decision = 'REJECT_QUALITY_OR_INSTRUCTION_REGRESSION'
    elif low_baseline:
        decision = 'INCONCLUSIVE_LOW_BASELINE'
    elif aggregate >= 0.2 and majority:
        decision = 'OBSERVATIONAL_GATE_PASSED'
    else:
        decision = 'GATE_NOT_MET'
    result = {'run': str(run), 'cases': cases, 'pairs': comparisons,
        'summary': {'decision': decision, 'reasoning_control': control_sum,
            'reasoning_candidate': candidate_sum, 'aggregate_reasoning_reduction': aggregate,
            'output_control': output_totals['control'], 'output_candidate': output_totals['candidate'],
            'output_reduction': reduction(output_totals['control'], output_totals['candidate']),
            'native_duration_control_ms': native_ms['control'], 'native_duration_candidate_ms': native_ms['candidate'],
            'native_duration_reduction': reduction(native_ms['control'], native_ms['candidate']),
            'controller_wall_control_ms': controller_ms['control'], 'controller_wall_candidate_ms': controller_ms['candidate'],
            'controller_wall_reduction': reduction(controller_ms['control'], controller_ms['candidate']),
            'exact_candidate_over_control_ratios': {
                'reported_reasoning': str(candidate_sum) + '/' + str(control_sum),
                'output': str(output_totals['candidate']) + '/' + str(output_totals['control']),
                'native_turn_duration': str(native_ms['candidate']) + '/' + str(native_ms['control']),
                'controller_wall': str(controller_ms['candidate']) + '/' + str(controller_ms['control'])},
            'nonzero_control_pairs': len(eligible), 'paired_reductions': reductions,
            'majority_reductions': majority, 'quality_complete': quality_complete,
            'control_quality_pass': control_quality_pass, 'candidate_quality_pass': candidate_quality_pass,
            'quality_nonregression': quality_nonregression, 'low_baseline': low_baseline,
            'low_baseline_rule': {'min_control_reasoning': args.min_control_reasoning,
                                  'min_nonzero_pairs': args.min_nonzero_pairs},
            'scope_valid': all_valid},
        'interpretation': 'One observation per arm per case. This is an observational screening gate, not statistical proof. Exact reported reasoning token counters are distinct from answer length; a native zero does not prove absence of internal reasoning and may leave the hypothesis below the observable floor.'}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
