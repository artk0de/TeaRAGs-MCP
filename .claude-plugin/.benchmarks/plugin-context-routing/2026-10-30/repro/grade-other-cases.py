#!/usr/bin/env python3
"""Independent, trace-based grading of the eight targeted/batch actor cases."""
import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
RUN = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / 'runs/20261030-182853-286087000'
ROOT = BASE.parent.parent
targeted = json.loads((ROOT / '.claude-plugin/.benchmarks/explore/evals/2026-10-30-targeted-context-reads.json').read_text())['evals']
batch = json.loads((ROOT / '.claude-plugin/.benchmarks/search-cascade/evals/2026-10-30-independent-read-batches.json').read_text())['cases']


def returned_bodies(call):
    result = call.get('result', {}).get('structuredContent', {})
    rows = result.get('results', [])
    if isinstance(rows, list):
        return {r['payload']['symbolId']: r['payload'].get('content', '') for r in rows if isinstance(r, dict) and 'payload' in r}
    columns = [x.removeprefix('payload.') for x in rows.get('columns', [])]
    values = [dict(zip(columns, r)) for r in rows.get('rows', [])]
    return {r['symbolId']: r.get('content', '') for r in values}


def grade(suite, case):
    key = suite + '-' + str(case['id'])
    directory = RUN / 'cases' / key
    status = json.loads((directory / 'actor/status.json').read_text())
    thread = json.loads((directory / 'actor/thread-read.json').read_text())['thread']
    turn = next(t for t in thread['turns'] if t['id'] == status['turn_id'])
    items = turn['items']
    mcps = [x for x in items if x['type'] == 'mcpToolCall']
    commands = [x for x in items if x['type'] == 'commandExecution']
    source_commands = [x for x in commands if '/home/plugins/' not in x['command']]
    finals = [x for x in items if x.get('phase') == 'final_answer']
    answer = '\n'.join(x['text'] for x in finals)
    normalized = answer.replace(',', '').lower()
    events = json.loads((directory / 'actor/turn-events.json').read_text())
    wrappers = [e['params']['item'] for e in events if e.get('method') == 'rawResponseItem/completed' and e.get('params', {}).get('item', {}).get('type') == 'custom_tool_call' and e['params']['item'].get('name') == 'exec']
    fixture = json.loads((directory / 'fixture.json').read_text())
    checks = []

    def check(name, passed, evidence):
        checks.append({'criterion': name, 'pass': bool(passed), 'evidence': evidence})

    check('native actor completed once', status['valid'] and status['attempt'] == 1 and len(finals) == 1, status)
    if suite == 'targeted':
        number = case['id']
        expected = case.get('grading', {}).get('required_body_ids', [])
        if expected:
            body = case['tool_fixtures'][0]['result']['results'][0]['payload']['content']
            call = mcps[0] if mcps else {}
            args = call.get('arguments', {})
            selected = args.get('symbols') or [args.get('symbol')]
            content = returned_bodies(call) if call else {}
            check('one direct correctly addressed body retrieval', len(mcps) == 1 and not source_commands and call.get('tool') == 'find_symbol' and selected == expected and args.get('project') == fixture['alias'] and args.get('path') == fixture['cwd'] and not args.get('metaOnly', False), {'tool_id': call.get('id'), 'arguments': args})
            check('nonempty body actually returned', content.get(expected[0], '').strip() == body.strip(), {'tool_id': call.get('id'), 'returned_body': content})
        else:
            check('no redundant retrieval', not mcps and not source_commands and (number != 3 or not commands), {'mcp_ids': [x['id'] for x in mcps], 'source_command_ids': [x['id'] for x in source_commands], 'all_command_ids': [x['id'] for x in commands]})
        facts = {
            1: '40' in answer and '160' in answer,
            2: all(x in normalized for x in ('attempt 0', '250', 'attempt 1', '500', 'attempt 4', '2000')),
            3: len(re.findall(r'^- ', answer, re.M)) == 2 and '250' in answer and '2000' in normalized and 'doubl' in normalized and 'src/retry/scheduler.ts:18' in answer,
            4: all(re.search(r'%s[^\n]*%s' % (code, value), normalized) for code, value in [('429', 'true'), ('503', 'true'), ('400', 'false')]),
        }
        check('answer facts and requested form', facts[number], answer)
    elif case['id'].startswith('B3'):
        expected = case['grading']['required_symbols']
        call = mcps[0] if mcps else {}
        args = call.get('arguments', {})
        actual = returned_bodies(call) if call else {}
        check('single symbols batch, no source shell reads', len(mcps) == 1 and not source_commands and call.get('tool') == 'find_symbol' and set(args.get('symbols', [])) == set(expected) and args.get('project') == fixture['alias'] and args.get('path') == fixture['cwd'], {'tool_id': call.get('id'), 'arguments': args})
        check('three actual nonempty method bodies', all(actual.get(symbol, '').strip() == fixture['find_symbol_bodies'][symbol]['body'].strip() for symbol in expected), {'tool_id': call.get('id'), 'returned_bodies': actual})
        check('answer distinguishes strict limit, delegation and false', 'attempt < attempts' in answer and 'delegat' in normalized and 'always returns `false`' in normalized, answer)
    else:
        required = case['grading']['required_reads']
        observed = {}
        for command in source_commands:
            actions = command.get('commandActions', [])
            reads = [a for a in actions if a['type'] == 'read']
            if len(reads) == 1:
                relative = str(Path(reads[0]['path']).relative_to(fixture['cwd']))
                observed[relative] = command
        check('every required per-file bounded read returned real bytes', not mcps and set(observed) == set(required) and len(source_commands) == len(required) and all(re.search(r"sed -n '\d+,\d+p'", observed[p]['command']) and observed[p]['exitCode'] == 0 and observed[p]['aggregatedOutput'] == fixture['files'][p] for p in required), {p: {'tool_id': x['id'], 'command': x['command'], 'output_bytes': len(x['aggregatedOutput']), 'started_ms': x.get('startedAtMs'), 'completed_ms': x.get('completedAtMs')} for p, x in observed.items()})
        batch_wrapper = wrappers[-1] if wrappers else {}
        code = batch_wrapper.get('input', '')
        expected_wrappers = 2 if case['id'].startswith('B4') else 1
        check('one executed Promise batch of known independent reads', len(wrappers) == expected_wrappers and bool(re.search(r'await Promise\.all(?:Settled)?\(', code)) and not re.search(r'=>\s*await\s+tools\.exec_command', code) and all(p in code for p in (required[1:] if expected_wrappers == 2 else required)), {'wrapper_id': batch_wrapper.get('id'), 'wrapper_call_id': batch_wrapper.get('call_id'), 'code': code})
        if expected_wrappers == 2:
            manifest, children = observed.get(required[0], {}), [observed.get(p, {}) for p in required[1:]]
            check('dependent manifest completed before child dispatch', manifest.get('completedAtMs', float('inf')) < min((x.get('startedAtMs', -1) for x in children), default=-1), {'manifest_id': manifest.get('id'), 'manifest_completed_ms': manifest.get('completedAtMs'), 'child_started_ms': [x.get('startedAtMs') for x in children]})
            correct = 'test_isolated' in normalized and 'disables timeout retries' in normalized and bool(re.search(r'production_east[^\n]*45', normalized)) and bool(re.search(r'test_isolated[^\n]*0 seconds', normalized))
        elif case['id'].startswith('B1'):
            correct = all(x in normalized for x in ['production expectations agree', 'test delay disagrees', '10 seconds', 'config/environments/test_delivery.yml', 'spec/jobs/report_delivery_job_spec.rb']) and all(x in answer for x in ['| Attempts | 5 | 2 | 2 |', '| Delay (seconds) | 30 | 0 | 0 | 10 |', '| Retry on timeout | true | false | false |'])
        else:
            correct = all(x in normalized for x in ['`id`', '`tenant_id`', '`file_key`', '`status`', '`completed_at`', '`created_at`', '`updated_at`', 'queued', 'idx_report_exports_tenant_status', 'rolling it back removes only that index'])
        check('answer facts', correct, answer)

    verdict = 'PASS' if all(x['pass'] for x in checks) else 'FAIL'
    return {'case': key, 'verdict': verdict, 'turn_id': status['turn_id'], 'checks': checks, 'wrapper_ids': [x['id'] for x in wrappers], 'mcp_ids': [x['id'] for x in mcps], 'source_command_ids': [x['id'] for x in source_commands], 'native_timing': 'UNVERIFIABLE: zero-ms/staggered native scheduler timing; workflow judged by executed wrapper and returned bytes' if suite == 'batch' and not case['id'].startswith('B3') else 'not required'}


results = [grade('targeted', c) for c in targeted] + [grade('batch', c) for c in batch]
report = {'run': str(RUN.resolve()), 'model': 'gpt-6.1-sol', 'effort': 'medium', 'arm': 'current plugin 0.53.8 only', 'independent_grader': '/root/eval_architecture_gate', 'pass_count': sum(x['verdict'] == 'PASS' for x in results), 'case_count': len(results), 'cases': results, 'limitations': ['No baseline arm was run; these results establish current behavior on synthetic fixtures, not a measured before/after improvement.', 'Native file-operation overlap is not measurable at sufficient timer precision; executed Promise batches and actual output bytes establish the workflow.']}
(BASE / 'grade-other-cases.json').write_text(json.dumps(report, indent=2) + '\n')
for result in results:
    print(result['verdict'], result['case'], 'failed=' + ','.join(x['criterion'] for x in result['checks'] if not x['pass']))
print(f"TOTAL {report['pass_count']}/{report['case_count']}")
sys.exit(0 if report['pass_count'] == report['case_count'] else 1)
