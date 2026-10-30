import collections
import json
import pathlib
import sys


def merged(intervals):
    out = []
    for a, b in sorted(intervals):
        if b < a:
            raise ValueError((a, b))
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def span(intervals):
    return sum(b-a for a, b in merged(intervals))/1000


source = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in source.open()]
turns = collections.OrderedDict()
for e in rows:
    if e.get('method') == 'turn/started':
        turns[e['params']['turn']['id']] = {'events': [], 'start': e['emittedAtMs']}
for e in rows:
    p = e.get('params', {})
    tid = p.get('turnId', p.get('turn', {}).get('id'))
    if tid in turns:
        turns[tid]['events'].append(e)

out = []
for qi, (tid, turn) in enumerate(turns.items(), 1):
    es = turn['events']
    end = next(e['emittedAtMs'] for e in es if e['method']=='turn/completed')
    tool = []
    stream = []
    hook = []
    tool_types = collections.Counter()
    hook_durations = collections.Counter()
    hook_counts = collections.Counter()
    tool_durations = collections.Counter()
    pending_hooks = {}
    raw = []
    executor = []
    pending_calls = {}
    details = []
    for e in es:
        p = e['params']
        method = e['method']
        if method=='hook/started':
            pending_hooks[p['run']['id']] = e['emittedAtMs']
        elif method=='hook/completed':
            r = p['run']
            start = pending_hooks.pop(r['id'])
            hook.append([start, e['emittedAtMs']])
            hook_durations[r['eventName']] += r['durationMs']/1000
            hook_counts[r['eventName']] += 1
        elif method=='item/completed':
            i = p['item']
            kind = i['type']
            if kind in ['mcpToolCall', 'commandExecution', 'agentMessage']:
                start, finish = i['startedAtMs'], i['completedAtMs']
                if kind=='agentMessage':
                    stream.append([start, finish])
                else:
                    tool.append([start, finish])
                    name = i.get('tool', kind)
                    tool_types[name] += 1
                    tool_durations[name] += (finish-start)/1000
                    details.append({'tool':name, 'start_offset':(start-turn['start'])/1000, 'end_offset':(finish-turn['start'])/1000})
        elif method=='rawResponse/completed':
            raw.append(p['usage'])
        elif method=='rawResponseItem/completed':
            i = p['item']
            if i['type'] in ['custom_tool_call', 'function_call']:
                pending_calls[i['call_id']] = e['emittedAtMs']
            elif i['type'] in ['custom_tool_call_output', 'function_call_output']:
                executor.append([pending_calls.pop(i['call_id']),e['emittedAtMs']])
    all_exec = tool+hook
    total = (end-turn['start'])/1000
    exec_union = span(all_exec)
    stream_exclusive = span(all_exec+stream)-exec_union
    outer_exec = span(executor+hook)
    outer_stream = span(executor+hook+stream)-outer_exec
    out.append({
        'q':f'Q{qi:02}', 'native_wall':total,
        'tool_count':sum(tool_types.values()),'tool_counts':tool_types,
        'tool_sum':sum((b-a)/1000 for a,b in tool), 'tool_union':span(tool),
        'tool_durations':tool_durations,
        'hook_count':sum(hook_counts.values()), 'hook_counts':hook_counts,
        'hook_reported_sum':sum(hook_durations.values()), 'hook_reported_by_event':hook_durations,
        'hook_observed_sum':sum((b-a)/1000 for a,b in hook), 'hook_union':span(hook),
        'execution_union':exec_union, 'tool_hook_overlap':span(tool)+span(hook)-exec_union,
        'agent_stream_union':span(stream), 'agent_stream_exclusive':stream_exclusive,
        'residual_after_exec':total-exec_union,
        'residual_after_exec_and_agent_stream':total-exec_union-stream_exclusive,
        'outer_executor_count':len(executor),
        'outer_executor_sum':sum((b-a)/1000 for a,b in executor),
        'outer_executor_union':span(executor),
        'outer_executor_hook_union':outer_exec,
        'outer_executor_hook_extra':outer_exec-span(executor),
        'outer_stream_exclusive':outer_stream,
        'outer_residual':total-outer_exec-outer_stream,
        'pending_calls':len(pending_calls),
        'raw_responses':len(raw), 'output_tokens':sum(u['outputTokens'] for u in raw),
        'reasoning_tokens':sum(u['reasoningOutputTokens'] for u in raw),
        'input_tokens':sum(u['inputTokens'] for u in raw),
        'cached_input_tokens':sum(u['cachedInputTokens'] for u in raw),
        'tool_details':details,
        'pending_hooks':len(pending_hooks),
    })
dest = pathlib.Path('.tmp/codex61/latency-agent.'+source.parent.name+'.json')
dest.write_text(json.dumps(out, indent=2))
numeric = [k for k,v in out[0].items() if isinstance(v,(float,int))]
print(json.dumps({'arm':source.parent.name,'totals':{k:round(sum(r[k] for r in out),6) for k in numeric}, 'tools':dict(sum((collections.Counter(r['tool_counts']) for r in out),collections.Counter())), 'hook_reported_by_event':dict(sum((collections.Counter(r['hook_reported_by_event']) for r in out),collections.Counter()))},indent=2))
