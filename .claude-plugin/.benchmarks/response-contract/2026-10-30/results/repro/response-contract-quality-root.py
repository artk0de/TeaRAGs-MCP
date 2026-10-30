"""Offline trace verification and explicit root semantic reviews for four pairs."""
import json
from pathlib import Path
import re
import sys

study = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
definitions = json.loads((root / '.claude-plugin/.benchmarks/response-contract/2026-10-30/evals.json').read_text())['evals']
table_expectations = next(c for c in definitions if c['id'] == 201)['grading']['expected_rows']
manual = {
    'batch-B1-Q34-config-spec': 'Both answers correctly compare main test defaults 5/30/true with overrides/request specs 2/0/false, identify job-spec delay 10, confirm production agreement, and qualify unspecified config precedence.',
    'batch-B2-Q36-known-migrations': 'Both answers preserve all columns/defaults, the tenant/status index and index-only rollback; no claim that rollback removes table, columns or data.',
    'response-201': 'Complete twelve-row tables preserve names, order, exact numeric cells, full purpose sentences and per-row locations. Explicit complete-table request overrides default cap.',
    'response-202': 'Independently read both final answers: all ten examples correct, attempt validation before status before budget, finite nonnegative hint rule and both bounds, no side effects, valid caller-side TypeScript example. Both exceed requested 450 words.',
}

def bodies(item):
    data = (item.get('result') or {}).get('structuredContent') or {}
    values = data.get('results', [])
    if isinstance(values, dict):
        return [dict(zip(values.get('columns', []), row)) for row in values.get('rows', [])]
    return [{'payload.' + k: v for k, v in row.get('payload', {}).items()} for row in values]

graded = {}
for arm in ['control', 'candidate']:
    for key, review in manual.items():
        directory = study / arm / 'cases' / key
        status = json.loads((directory / 'actor/status.json').read_text())
        fixture = json.loads((directory / 'fixture.json').read_text())
        events = [json.loads(line) for line in (directory / 'actor/events.jsonl').open()]
        items, seen, finals, wrappers = [], set(), [], []
        for event in events:
            item = event.get('params', {}).get('item', {})
            if event.get('method') == 'item/completed' and item.get('id') not in seen:
                seen.add(item.get('id')); items.append(item)
            if event.get('method') == 'rawResponseItem/completed':
                if item.get('type') == 'custom_tool_call': wrappers.append(item)
                if item.get('type') == 'message' and item.get('role') == 'assistant' and item.get('phase') == 'final_answer':
                    finals.append(''.join(x.get('text', '') for x in item.get('content', [])))
        answer = '\n'.join(finals)
        commands = [i for i in items if i.get('type') == 'commandExecution' and '/home/plugins/' not in i.get('command', '')]
        mcps = [i for i in items if i.get('type') == 'mcpToolCall']
        checks = {'completed_once': status.get('valid') and status.get('attempt') == 1 and sum(e.get('method') == 'turn/started' for e in events) == 1,
                  'one_final_answer': len(finals) == 1, 'independent_manual_semantics_review': True}
        evidence = {'manual_review': review, 'word_count': len(answer.split()), 'word_count_method': 'Whitespace separated, including Markdown', 'tool_ids': [i['id'] for i in commands + mcps]}
        if key.startswith('batch-'):
            observed = {}
            for item in commands:
                reads = [a for a in item.get('commandActions', []) if a.get('type') == 'read']
                if len(reads) == 1:
                    observed[str(Path(reads[0]['path']).relative_to(fixture['cwd']))] = item
            checks['all_required_bounded_file_bytes'] = not mcps and set(observed) == set(fixture['files']) and len(commands) == len(fixture['files']) and all(i.get('exitCode') == 0 and i.get('aggregatedOutput') == fixture['files'][path] and re.search(r"sed -n '\d+,\d+p'", i.get('command', '')) for path, i in observed.items())
            checks['one_actual_promise_batch'] = len(wrappers) == 1 and bool(re.search(r'await Promise\.all(?:Settled)?\(', wrappers[0].get('input', ''))) and all(p in wrappers[0].get('input', '') for p in fixture['files'])
            checks['relevant_code_locations'] = 'db/migrate/' in answer if 'B2' in key else 'config/report_delivery.yml' in answer and 'spec/jobs/report_delivery_job_spec.rb' in answer
            if arm == 'candidate': checks['ordinary_default_word_cap'] = len(answer.split()) <= 180
        elif key == 'response-201':
            source = fixture['files']['config/delivery_policies.yml']
            checks['actual_config_bytes_read'] = any(i.get('exitCode') == 0 and source.strip() in re.sub(r'^\s*\d+\s+', '', i.get('aggregatedOutput', ''), flags=re.M).strip() for i in commands)
            rows = [line for line in answer.splitlines() if line.startswith('|')]
            positions, row_checks = [], []
            for expected in table_expectations:
                hits = [(n, row) for n, row in enumerate(rows) if expected['name'] in row]
                good, detail = False, {}
                if len(hits) == 1:
                    n, row = hits[0]; positions.append(n)
                    cells = [c.strip().strip('`') for c in row.strip('|').split('|')]
                    numbers = all(str(expected[field]) in cells for field in ['attempts', 'delay_ms', 'timeout_ms'])
                    purpose = expected['purpose'] in row
                    locations = [int(n) for n in re.findall(r'delivery_policies\.yml(?::|#L)(\d+)', row)]
                    location = any(expected['startLine'] <= n <= expected['startLine'] + 4 for n in locations)
                    good = numbers and purpose and location
                    detail = dict(numbers=numbers, full_purpose=purpose, location=location)
                row_checks.append(dict(name=expected['name'], passed=good, **detail))
            checks['all_twelve_rows_exact_in_order'] = len(rows) == 14 and all(c['passed'] for c in row_checks) and positions == sorted(positions) and len(positions) == 12
            evidence['row_checks'] = row_checks
        else:
            actual = [row for item in mcps for row in bodies(item) if row.get('payload.symbolId') == 'RetryController#plan' and row.get('payload.content')]
            checks['actual_plan_body_read'] = bool(actual)
            checks['requested_deep_length'] = len(answer.split()) >= 450
            checks['code_and_locations'] = '```ts' in answer and 'RetryController.ts' in answer
            checks['all_ten_examples_present'] = all(token in answer.replace(' ', '') for token in ['(429,0)', '(503,2)', '(429,3)', '(400,0)', '(400,-1)', '(429,1,50)', '(429,1,400)', '(429,1,900)', '(429,1,NaN)', '(429,1,-10)'])
        graded[arm + ':' + key] = {'pass': all(checks.values()), 'checks': checks, 'evidence': evidence, 'final_answer': answer}
out = {'reviewer': 'root, independent of these four case authors', 'cases': graded, 'passed': sum(v['pass'] for v in graded.values()), 'total': len(graded), 'limitations': ['Semantic correctness is an explicitly recorded independent manual review, not a brittle match to expected answer wording.', 'Promise dispatch is checked separately from native scheduler overlap timing.']}
destination = Path(__file__).with_suffix('.json'); destination.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
for key, value in graded.items(): print(key, 'PASS' if value['pass'] else 'FAIL', {k: v for k, v in value['checks'].items() if not v})
print('TOTAL', str(out['passed']) + '/' + str(out['total']))
sys.exit(0 if out['passed'] == out['total'] else 1)
