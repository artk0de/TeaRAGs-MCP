"""Offline scalar context/attribution extraction; never reads reasoning content.

Input: existing actor events.jsonl.gz. No model, upstream or product execution.
Attribution groups use item types and observable tool wrapper requests; mixed
requests remain unclassified. They are context composition, not waste estimates.
"""
import collections
import gzip
import json
import re
import sys
from pathlib import Path

src,dst=map(Path,sys.argv[1:3])
turns={};items={};calls={};seen_responses=set();responses=[];compactions=[];active_compaction=set()
dump_calls={'call_79857684e83449eb975ab8eba96a7b68','call_fbce0ed009d543f095e78de04da30511'}
source_tools={'find_symbol','semantic_search','hybrid_search','find_similar','get_callees','get_callers','trace_path','find_cycles','find_co_changed','get_architecture_report','rank_chunks'}
def tool_group(code,call_id):
    names=re.findall(r'tools\.(\w+)\s*\(',code)
    if not names and 'ALL_TOOLS' in code:
        return 'tool_metadata_dump' if call_id in dump_calls else 'other_tool_discovery'
    if names and all(n=='exec_command' for n in names):
        if '/skills/' in code and '/plugins/cache/' in code:return 'skill_or_reference_output'
        if any(x in code for x in ['sed ','rg ','grep ','cat ','find ','pwd']):return 'shell_observation_output'
    if names and all(n=='read_mcp_resource' for n in names):
        return 'navigation_reference_output' if 'tea-rags://guide/navigation' in code else 'other_reference_output'
    if names and all(n.startswith('mcp__tea_rags__') for n in names):
        bare=[n.split('mcp__tea_rags__',1)[1] for n in names]
        if all(n in source_tools for n in bare):return 'source_mcp_output'
        if all(n in {'list_projects','get_index_status','get_index_metrics','get_naming_lexicon','get_ontology_report'} for n in bare):return 'metadata_or_status_output'
    return 'unclassified_tool_output'

with gzip.open(src,'rt') as stream:
    for line in stream:
        e=json.loads(line);p=e.get('params',{});tid=p.get('turnId') or p.get('turn',{}).get('id')
        if e.get('method')=='turn/started':turns.setdefault(tid,'Q%02d'%(len(turns)+1))
        if e.get('method')=='item/started' and p.get('item',{}).get('type')=='contextCompaction':active_compaction.add(tid)
        if e.get('method')=='rawResponseItem/completed':
            it=p.get('item',{});kind=it.get('type');iid=it.get('id')
            if kind=='custom_tool_call':calls[it.get('call_id')]=tool_group(it.get('input',''),it.get('call_id'));group='tool_call_history'
            elif kind=='custom_tool_call_output':group=calls.get(it.get('call_id'),'unclassified_tool_output')
            elif kind=='reasoning':group='opaque_reasoning_state' # type only; no summary/encrypted content access
            elif kind=='additional_tools':group='native_tool_definitions'
            elif kind=='message':group={'developer':'developer_context','user':'user_context','assistant':'assistant_message_history'}.get(it.get('role'),'other_message')
            else:group='other_item'
            if iid:items[iid]=group
        if e.get('method')=='item/completed' and p.get('item',{}).get('type')=='contextCompaction':
            it=p['item'];compactions.append({'question':turns.get(tid),'started_at_ms':it.get('startedAtMs'),'completed_at_ms':it.get('completedAtMs')})
            active_compaction.discard(tid)
        if e.get('method')!='rawResponse/completed' or p.get('responseId') in seen_responses:continue
        seen_responses.add(p.get('responseId'))
        usage=p.get('usage',{});attr=p.get('usageMetadata',{}).get('metadata',{}).get('attribution',{}).get('items',{})
        groups=collections.Counter();counts=collections.Counter()
        for iid,val in attr.items():
            tokens=val.get('input_tokens',0)
            if tokens:group=items.get(iid,'unmapped_item');groups[group]+=tokens;counts[group]+=1
        responses.append({'question':turns.get(tid),'response_id':p.get('responseId'),'completed_event_ms':e.get('emittedAtMs'),
            'request_kind':'context_compaction' if tid in active_compaction else 'ordinary',
            'input_tokens':usage.get('inputTokens'),'cached_input_tokens':usage.get('cachedInputTokens'),
            'attributed_input_tokens':sum(groups.values()),'input_by_group':dict(groups),'items_by_group':dict(counts)})

rows=[]
for q in turns.values():
    rs=[r for r in responses if r['question']==q]
    if rs:
        peak=max(rs,key=lambda r:r['input_tokens'] or 0)
        rows.append({'question':q,'responses':len(rs),'first_input_tokens':rs[0]['input_tokens'],
            'last_input_tokens':rs[-1]['input_tokens'],'max_input_tokens':peak['input_tokens'],
            'max_ordinary_input_tokens':max((r['input_tokens'] or 0 for r in rs if r['request_kind']=='ordinary'),default=None),
            'max_request_kind':peak['request_kind'],'max_response_id':peak['response_id']})
snaps=[]
for q in ['Q01','Q02','Q03','Q04','Q05','Q32']:
    rs=[r for r in responses if r['question']==q]
    if rs:snaps.append({'selection':q+'_last' if q in ['Q01','Q02','Q03','Q04'] else q+'_max',**(rs[-1] if q in ['Q01','Q02','Q03','Q04'] else max(rs,key=lambda r:r['input_tokens'] or 0))})
overall=max(responses,key=lambda r:r['input_tokens'] or 0)
result={'source':str(src),'scope':'Single rawResponse usage.inputTokens, not cumulative thread usage. Cached input is a subset.',
    'per_question':rows,'overall_max':overall,'overall_max_ordinary_input_tokens':max(r['input_tokens'] or 0 for r in responses if r['request_kind']=='ordinary'),
    'compactions':compactions,'selected_snapshots':snaps,
    'attribution_method':'usageMetadata.metadata.attribution.items matched to raw item IDs. Tool output labels use observable wrapper requests; shell observations include inventories. Mixed/unmapped items retained explicitly. Reasoning contents never inspected.',
    'attribution_limit':'Composition of retained request context, not newly read unique tokens, removable waste, or causal responsibility for compaction.',
    'attribution_sum_matches_input_for_all_responses':all(r['attributed_input_tokens']==r['input_tokens'] for r in responses)}
dst.write_text(json.dumps(result,ensure_ascii=False,indent=2))
print('questions',len(rows),'max',overall['question'],overall['input_tokens'],'attribution_matches',result['attribution_sum_matches_input_for_all_responses'])
for r in rows[:5]:print(r)
print('peak_groups',overall['input_by_group'])
