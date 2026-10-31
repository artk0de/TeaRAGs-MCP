#!/usr/bin/env python3
"""Offline metadata-only accounting. Never accesses reasoning content/summary/encryption."""
import json, pathlib, collections, re, hashlib, sys, unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
OUT=pathlib.Path(__file__).resolve().parent
SOURCES={'latest_A':'.tmp/gruntworx_codex_A_2026-10-31_v4_01/runs/A','reference_B':'.tmp/gruntworx_codex_optimal_B_retry_2026-10-31_01/runs/B','previous_A':'.tmp/gruntworx_codex_optimal_AB_2026-10-31/runs/A'}
def merged(intervals):
 out=[]
 for a,b in sorted((a,b) for a,b in intervals if a is not None and b is not None and b>=a):
  if out and a<=out[-1][1]:out[-1][1]=max(b,out[-1][1])
  else:out.append([a,b])
 return out
def length(v):return sum(b-a for a,b in merged(v))/1000
def clipped(v,a,b):return [(max(a,x),min(b,y)) for x,y in v if x<b and y>a]
def analyze(label,rel):
 p=ROOT/rel; marks=json.loads((p/'marks.json').read_text());status=json.loads((p/'status.json').read_text()); questions=[]
 for mark in marks:
  f=p/(mark['id']+'-events.json');ev=json.loads(f.read_text());starts={};hooks=[];native=[];outer=[];calls={};agent={};responses=[];pending=[];reasoning_ids=set();unmatched=[]
  turn_start=next(e['emittedAtMs'] for e in ev if e['method']=='turn/started');turn_end=next(e['emittedAtMs'] for e in ev if e['method']=='turn/completed')
  for n,e in enumerate(ev):
   method=e['method'];d=e['params'];t=e['emittedAtMs'];i=d.get('item',{});typ=i.get('type');id=i.get('id')
   if method=='item/completed':
    if typ=='agentMessage':agent[id]={'phase':i.get('phase'),'nonempty':bool(i.get('text','').strip())}
    if typ not in ['userMessage','agentMessage','reasoning']:
     native.append({'id':id,'type':typ,'tool':i.get('tool'),'server':i.get('server'),'start_ms':i.get('startedAtMs'),'end_ms':i.get('completedAtMs'),'declared_duration_ms':i.get('durationMs')})
   if method=='hook/started':
    run=d['run'];starts.setdefault(run['id'],[]).append(t)
   if method=='hook/completed':
    run=d['run'];stack=starts.get(run['id'],[]);a=stack.pop(0) if stack else None
    hooks.append({'id':run['id'],'event':run['eventName'],'start_ms':a,'end_ms':t,'declared_duration_ms':run.get('durationMs')})
   if method=='rawResponseItem/completed':
    if typ=='reasoning':reasoning_ids.add(id);pending.append({'type':typ,'id':id})
    elif typ in ['custom_tool_call','function_call']:
     text=i.get('input',i.get('arguments','')); names=re.findall(r'tools\.([A-Za-z0-9_]+)\s*\(',text)
     proof={'id':id,'call_id':i.get('call_id'),'name':i.get('name'),'start_ms':t,'event_index':n,'nested_tool_names':names,'explicit_wait':i.get('name')=='wait' or bool(re.search(r'tools\.(?:wait|write_stdin)\s*\(',text))}
     calls[i.get('call_id')]=proof;pending.append({'type':typ,'id':id,'call_id':i.get('call_id')})
    elif typ in ['custom_tool_call_output','function_call_output']:
     call=calls.get(i.get('call_id'))
     if call: outer.append({**call,'end_ms':t,'output_event_index':n})
     else:unmatched.append(i.get('call_id'))
    elif typ=='message' and i.get('role')=='assistant':pending.append({'type':typ,'id':id})
   if method=='rawResponse/completed':
    responses.append({'id':d['responseId'],'completed_ms':t,'event_index':n,'usage':d.get('usage',{}),'items':pending});pending=[]
  ni=[(x['start_ms'],x['end_ms']) for x in native];hi=[(x['start_ms'],x['end_ms']) for x in hooks];oi=[(x['start_ms'],x['end_ms']) for x in outer];allints=merged(ni+hi+oi)
  prev=turn_start
  for r in responses:
   r['interval_start_ms']=prev;r['interval_seconds']=(r['completed_ms']-prev)/1000;r['measured_runtime_union_seconds']=length(clipped(allints,prev,r['completed_ms']));r['model_network_client_residual_seconds']=r['interval_seconds']-r['measured_runtime_union_seconds'];prev=r['completed_ms']
   tool=[i for i in r['items'] if i['type'] in ['custom_tool_call','function_call']];phases=[agent.get(i['id'],{}).get('phase') for i in r['items'] if i['type']=='message'];r['agent_phases']=phases
   r['category']='tool' if tool else 'final' if 'final_answer' in phases else 'commentary_only' if 'commentary' in phases else 'empty_or_reasoning_only';r['reasoning_item_count']=sum(i['type']=='reasoning' for i in r['items']);r['explicit_wait']=any(calls[i['call_id']]['explicit_wait'] for i in tool)
  usage=collections.Counter()
  for r in responses:usage.update(r['usage'])
  q={'id':mark['id'],'turn_id':mark['turn_id'],'source':str(f.relative_to(ROOT)),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'actor_wall_seconds':mark['wall_seconds'],'pre_turn_verification_seconds':mark.get('pre_turn_verification_seconds',0),'native_turn_seconds':(turn_end-turn_start)/1000,'turn_start_ms':turn_start,'turn_end_ms':turn_end,'responses':responses,'response_count':len(responses),'usage':dict(usage),'reasoning_item_count':len(reasoning_ids),'native_tool_intervals':native,'hook_intervals':hooks,'outer_executor_intervals':outer,'native_tool_union_seconds':length(ni),'hook_union_seconds':length(hi),'native_tool_hook_union_seconds':length(ni+hi),'outer_executor_union_seconds':length(oi),'all_runtime_union_seconds':length(allints),'runtime_union_intervals_ms':allints,'model_network_client_residual_seconds':(turn_end-turn_start)/1000-length(allints),'unmatched_tool_outputs':unmatched,'categories':dict(collections.Counter(r['category'] for r in responses))}
  assert q['response_count']==mark['accounting']['completed_responses'],(label,q['id'])
  assert {r['id'] for r in responses}==set(mark['accounting']['responses']),(label,q['id'],'response IDs')
  assert all(usage.get(k,0)==v for k,v in mark['accounting']['completed_usage'].items()),(label,q['id'],'native usage mismatch')
  assert not unmatched,(label,q['id'],'unmatched tool output')
  assert all(a is not None and b is not None and a<=b for a,b in ni+hi+oi),(label,q['id'],'missing interval timestamp')
  questions.append(q)
 fields=['actor_wall_seconds','native_turn_seconds','pre_turn_verification_seconds','response_count','reasoning_item_count','native_tool_union_seconds','hook_union_seconds','native_tool_hook_union_seconds','outer_executor_union_seconds','all_runtime_union_seconds','model_network_client_residual_seconds']
 totals={k:sum(q[k] for q in questions) for k in fields};totals['usage']=dict(sum((collections.Counter(q['usage']) for q in questions),collections.Counter()));totals['categories']=dict(sum((collections.Counter(q['categories']) for q in questions),collections.Counter()));totals['explicit_wait_response_count']=sum(r['explicit_wait'] for q in questions for r in q['responses']);totals['cached_input_fraction']=totals['usage'].get('cachedInputTokens',0)/totals['usage']['inputTokens']
 totals['native_tool_types']=dict(collections.Counter(x['type'] for q in questions for x in q['native_tool_intervals']));totals['nested_tool_names']=dict(collections.Counter(t for q in questions for x in q['outer_executor_intervals'] for t in x['nested_tool_names']))
 totals['controller_actor_minus_question_wall_seconds']=status['actor_wall_seconds']-totals['actor_wall_seconds']
 totals['controller_actor_minus_native_turn_seconds']=status['actor_wall_seconds']-totals['native_turn_seconds']
 totals['controller_verification_minus_pre_turn_seconds']=status['verification_seconds']-totals['pre_turn_verification_seconds']
 totals['accounting_validation']='Every response ID, per-question response count, and each native usage field agrees with controller marks; all tool outputs matched; all measured intervals have valid timestamps.'
 return {'source':rel,'status':status,'totals':totals,'questions':questions}
class UnionTests(unittest.TestCase):
 def test_parallel_nested_adjacent(self):self.assertEqual(merged([(0,1000),(200,300),(500,1500),(1500,2000)]),[[0,2000]])
 def test_clip(self):self.assertEqual(length(clipped([(0,2000),(3000,4000)],1000,3500)),1.5)
 def test_disjoint(self):self.assertEqual(length([(1,1001),(2001,3001)]),2)
def main():
 runs={k:analyze(k,v) for k,v in SOURCES.items()};comparisons={}
 for ref in ['reference_B','previous_A']:
  a=runs['latest_A'];b=runs[ref];rows=[]
  for x,y in zip(a['questions'],b['questions']):
   assert x['id']==y['id'];row={'id':x['id']}
   for field in ['actor_wall_seconds','response_count','native_tool_union_seconds','hook_union_seconds','all_runtime_union_seconds','model_network_client_residual_seconds']:
    row[field+'_delta']=x[field]-y[field]
   row['output_tokens_delta']=x['usage']['outputTokens']-y['usage']['outputTokens'];rows.append(row)
  comparisons[ref]={'per_question':rows,'largest_actor_deltas':sorted(rows,key=lambda x:x['actor_wall_seconds_delta'],reverse=True)}
 result={'method':'Metadata-only offline parse; observed timestamps. Native runtime, hooks and outer executor intervals unioned, never summed in parallel. Residual includes model/network/client/queue effects, not pure inference. No reasoning text inspected. Response interval boundaries are previous response completion, not request send.','runs':runs,'comparisons':comparisons}
 (OUT/'accounting.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({k:v['totals'] for k,v in runs.items()},indent=2));print('TOP DELTAS',json.dumps({k:v['largest_actor_deltas'][:8] for k,v in comparisons.items()},indent=2))
if __name__=='__main__':
 if '--test' in sys.argv:unittest.main(argv=[sys.argv[0]])
 else:main()
