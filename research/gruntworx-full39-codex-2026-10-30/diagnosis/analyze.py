import collections
import gzip
import hashlib
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(sys.argv[2])
turns = {}
seen_items = set()
seen_responses = set()
hook_texts = {}
compactions = []
latest_thread_usage = None
def new_turn(tid):
    if tid not in turns:
        turns[tid] = {'id': 'Q%02d' % (len(turns)+1), 'tools': [], 'messages': [],
                      'responses': 0, 'usage': collections.Counter(), 'hooks': [],
                      'prompt': '', 'wall_ms': None}
    return turns[tid]
with gzip.open(source, 'rt') as stream:
    for line in stream:
        event = json.loads(line)
        method = event.get('method')
        p = event.get('params', {})
        tid = p.get('turnId') or p.get('turn', {}).get('id')
        if method == 'turn/started':
            new_turn(tid)
        if tid not in turns:
            continue
        q = turns[tid]
        if method == 'thread/tokenUsage/updated':
            latest_thread_usage = p.get('tokenUsage', {}).get('total')
        if method == 'turn/completed':
            q['wall_ms'] = p.get('turn', {}).get('durationMs')
        elif method == 'rawResponse/completed':
            rid = p.get('responseId')
            if rid in seen_responses:
                continue
            seen_responses.add(rid)
            q['responses'] += 1
            q['usage'].update(p.get('usage', {}))
        elif method == 'hook/completed':
            run = p['run']
            texts = [x.get('text', '') for x in run.get('entries', [])]
            text = '\n'.join(texts)
            h = hashlib.sha256(text.encode()).hexdigest()
            if text:
                hook_texts[h] = text
            q['hooks'].append({'event': run.get('eventName'), 'duration_ms': run.get('durationMs'),
                'status': run.get('status'), 'chars': len(text), 'hash': h if text else None})
        elif method == 'item/completed':
            item = p.get('item', {})
            iid = item.get('id')
            if iid in seen_items:
                continue
            seen_items.add(iid)
            kind = item.get('type')
            if kind == 'contextCompaction':
                compactions.append({'question': q['id'], 'id': iid,
                    'duration_ms': item['completedAtMs'] - item['startedAtMs']})
            if kind == 'userMessage':
                q['prompt'] = '\n'.join(x.get('text', '') for x in item.get('content', []))
            if kind in ('mcpToolCall', 'commandExecution'):
                q['tools'].append({'id': iid, 'tool': item.get('tool', 'shell'),
                    'args': item.get('arguments', item.get('command')),
                    'duration_ms': item.get('durationMs'), 'status': item.get('status'),
                    'exit_code': item.get('exitCode'), 'error': item.get('error'),
                    'started_ms': item.get('startedAtMs'), 'completed_ms': item.get('completedAtMs')})
            elif kind == 'agentMessage':
                q['messages'].append({'phase': item.get('phase'), 'text': item.get('text', '')})

qs = list(turns.values())
tool_counts = collections.Counter(t['tool'] for q in qs for t in q['tools'])
resources = collections.Counter()
repeated = collections.Counter()
hook_counts = collections.Counter()
hook_chars = collections.Counter()
hook_ms = collections.Counter()
all_usage = collections.Counter()
for q in qs:
    all_usage.update(q['usage'])
    q['tool_ms_sum'] = sum(t['duration_ms'] or 0 for t in q['tools'])
    q['hook_ms_sum'] = sum(h['duration_ms'] or 0 for h in q['hooks'])
    for t in q['tools']:
        args = t['args']
        repeated[(t['tool'], json.dumps(args, sort_keys=True, ensure_ascii=False))] += 1
        if t['tool'] == 'read_mcp_resource' and isinstance(args, dict):
            resources[args.get('uri', '')] += 1
    for h in q['hooks']:
        hook_counts[h['event']] += 1
        hook_ms[h['event']] += h['duration_ms'] or 0
        if h['hash']:
            hook_chars[h['hash']] += 1
summary = {'source': str(source), 'turn_count': len(qs), 'responses': sum(q['responses'] for q in qs),
    'usage': dict(all_usage), 'thread_usage': latest_thread_usage, 'compactions': compactions,
    'tools': dict(tool_counts), 'resources': dict(resources),
    'tool_ms_sum': sum(q['tool_ms_sum'] for q in qs),
    'hooks': {'counts': dict(hook_counts), 'ms_sum': dict(hook_ms),
        'texts': [{'sha256': h, 'count': n, 'chars': len(hook_texts[h]), 'text': hook_texts[h]}
                  for h, n in hook_chars.most_common()]},
    'repeated_exact_calls': [{'tool': t, 'args': json.loads(a), 'count': n}
                             for (t, a), n in repeated.most_common() if n > 1],
    'questions': qs}
dest.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps({k: v for k, v in summary.items() if k not in ('questions', 'hooks', 'repeated_exact_calls')}, ensure_ascii=False))
print('hooks', json.dumps({'counts':dict(hook_counts),'ms_sum':dict(hook_ms),
    'nonempty_outputs':sum(hook_chars.values()), 'chars_emitted':sum(n*len(hook_texts[h]) for h,n in hook_chars.items())}))
print('Q wall_s responses output reasoning tools tool_s hook_s')
for q in qs:
    print(q['id'], round((q['wall_ms'] or 0)/1000,3), q['responses'],q['usage'].get('outputTokens'),
          q['usage'].get('reasoningOutputTokens'),len(q['tools']),round(q['tool_ms_sum']/1000,3),round(q['hook_ms_sum']/1000,3))
print('repeated', json.dumps(summary['repeated_exact_calls'][:12], ensure_ascii=False))
print('hook texts', json.dumps([{'count':n,'chars':len(hook_texts[h]),'preview':hook_texts[h][:260]}
                              for h,n in hook_chars.most_common(10)],ensure_ascii=False))
