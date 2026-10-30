"""Offline raw response/compaction/context/duplicate-read accounting.

No question/gold/home access, no network, no reasoning content inspection.
Usage totals from raw responses and thread usage are reported separately.
"""
import argparse
import collections
import gzip
import hashlib
import json
from pathlib import Path

FIELDS=('inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens')
ap=argparse.ArgumentParser();ap.add_argument('events',type=Path);ap.add_argument('--output',type=Path,required=True)
args=ap.parse_args();turns={};active=set();responses=[];compactions=[];seen=set();windows=set();last_thread=None;reads=[];tool_seen=set();compaction_seen=set();warnings=[]
def usage_sum(rs):
    return {k:sum(r['usage'][k] for r in rs) if rs and all(isinstance(r['usage'].get(k),int) for r in rs) else None for k in FIELDS}
stream=gzip.open(args.events,'rt') if args.events.suffix=='.gz' else args.events.open()
for line in stream:
    e=json.loads(line);p=e.get('params',{});method=e.get('method');tid=p.get('turnId') or p.get('turn',{}).get('id')
    if method=='turn/started':turns.setdefault(tid,'Q%02d'%(len(turns)+1))
    if method=='thread/tokenUsage/updated':
        token=p.get('tokenUsage',{});last_thread=token.get('total')
        if isinstance(token.get('modelContextWindow'),int):windows.add(token['modelContextWindow'])
    item=p.get('item',{})
    if method=='item/started' and item.get('type')=='contextCompaction':active.add(tid)
    if method=='item/completed' and item.get('type')=='contextCompaction':
        iid=item.get('id')
        if not iid:warnings.append('Compaction completion missing native id; occurrence retained without deduplication')
        if not iid or (tid,iid) not in compaction_seen:
            compactions.append({'question':turns.get(tid),'native_item_id':iid,'started_at_ms':item.get('startedAtMs'),'completed_at_ms':item.get('completedAtMs')})
            if iid:compaction_seen.add((tid,iid))
        active.discard(tid)
    if method=='rawResponse/completed' and (not p.get('responseId') or p['responseId'] not in seen):
        if p.get('responseId'):seen.add(p['responseId'])
        else:warnings.append('Raw response missing native responseId; occurrence retained without deduplication')
        u=p.get('usage',{})
        if tid is None or tid not in turns:warnings.append('Raw response has no mapped turnId')
        responses.append({'question':turns.get(tid),'response_id':p.get('responseId'),'kind':'compaction' if tid in active else 'ordinary',
            'usage':{k:u.get(k) for k in FIELDS}})
    if method!='item/completed' or item.get('type') not in {'commandExecution','mcpToolCall'}:continue
    key=(tid,item.get('id'))
    if item.get('id'):
        if key in tool_seen:continue
        tool_seen.add(key)
    else:warnings.append('Completed read observation missing native item id; occurrence retained without deduplication')
    group=None
    if item['type']=='commandExecution':
        command=str(item.get('command',''));payload=item.get('aggregatedOutput')
        if '/skills/' in command:group='skill_or_reference_shell_read'
        elif any(x in command for x in ['sed ','cat ','rg ','grep ']):group='source_or_inventory_shell_observation'
    else:
        tool=item.get('tool','');arguments=item.get('arguments',{});payload=item.get('result')
        if isinstance(arguments,str):
            try:arguments=json.loads(arguments)
            except ValueError:arguments={}
        uri=arguments.get('uri','') if isinstance(arguments,dict) else ''
        if uri.startswith('tea-rags://'):group='reference_resource_read'
        elif tool in {'find_symbol','semantic_search','hybrid_search','search_code','find_similar','rank_chunks','get_callees','get_callers','trace_path'} or tool.rsplit('__',1)[-1] in {'find_symbol','semantic_search','hybrid_search','search_code','find_similar','rank_chunks','get_callees','get_callers','trace_path'}:group='source_mcp_observation'
    if group and payload is not None:
        serialized=payload if isinstance(payload,str) else json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':'))
        reads.append({'question':turns.get(tid),'item_id':item.get('id'),'group':group,'result_sha256':hashlib.sha256(serialized.encode()).hexdigest(),'result_chars':len(serialized)})
stream.close()
perq=[]
for q in turns.values():
    rs=[r for r in responses if r['question']==q];inputs=[r['usage']['inputTokens'] for r in rs if isinstance(r['usage']['inputTokens'],int)]
    perq.append({'question':q,'response_count':len(rs),'first_input_tokens':inputs[0] if inputs else None,'last_input_tokens':inputs[-1] if inputs else None,
        'max_input_tokens':max(inputs,default=None),'raw_usage':usage_sum(rs)})
dups=[]
for (group,digest),count in collections.Counter((r['group'],r['result_sha256']) for r in reads).items():
    if count>1:
        rs=[r for r in reads if r['group']==group and r['result_sha256']==digest]
        dups.append({'group':group,'sha256':digest,'count':count,'questions':[r['question'] for r in rs],'result_chars_each':rs[0]['result_chars']})
result={'scope':'Raw response usage includes ordinary and compaction responses; cached input and reasoning output are subsets, not additive. Exact output duplicates are observations, not proof of waste or unique source tokens.',
    'model_context_windows_reported':sorted(windows),'thread_latest_total':last_thread,'per_question':perq,'responses':responses,'compactions':compactions,
    'raw_usage_by_kind':{kind:usage_sum([r for r in responses if r['kind']==kind]) for kind in ['ordinary','compaction']},
    'raw_usage_all_responses':usage_sum(responses),
    'usage_field_coverage':{k:sum(isinstance(r['usage'].get(k),int) for r in responses) for k in FIELDS},
    'duplicate_read_results':dups,'read_observations':reads,'warnings':warnings,'reasoning_content_inspected':False}
args.output.write_text(json.dumps(result,indent=2));print('Offline raw metrics:',len(responses),'responses;',len(compactions),'compactions; reported windows',sorted(windows))
