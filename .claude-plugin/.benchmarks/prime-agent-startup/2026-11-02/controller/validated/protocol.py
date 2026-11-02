"""Native 0.166 request semantics and conservative model-response accounting.

No model calls at import. No synthetic answers. One blocking queue wait, bounded
by a whole-turn deadline; no sleeps, polling loop or per-question grace timer.
"""
import time
from decimal import Decimal

FIELDS=('inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens')
class ProtocolError(RuntimeError):pass

def turn_id(event):
 p=event.get('params') or {}
 return p.get('turnId') or (p.get('turn') or {}).get('id')

class TurnObserver:
 def __init__(self, turn):
  self.turn=turn;self.requests=[];self.completed=None;self.events=[];self.blocking=None
 def feed(self,event):
  self.events.append(event)
  if turn_id(event)!=self.turn:return
  if event.get('method')=='item/tool/requestUserInput' and 'id' in event:
   flag=event['params'].get('isBlocking')
   if type(flag) is not bool:raise ProtocolError('Native request missing required boolean isBlocking; do not guess or answer')
   self.requests.append(event)
   if flag:self.blocking=event
  if event.get('method')=='turn/completed':self.completed=event['params']['turn']

def await_turn(rpc,turn,timeout=1800,cleanup_timeout=30,on_event=None):
 observer=TurnObserver(turn);deadline=time.monotonic()+timeout;cleanup=None
 pending,rpc.pending=rpc.pending,[]
 # Pending events collected by turn/start must be observed before deciding cleanup.
 def observe(event):
  if on_event:on_event(event)
  observer.feed(event)
 for event in pending:observe(event)
 while not observer.completed:
  if observer.blocking and cleanup is None:
   cleanup={'reason':'Genuine unanswered blocking native request; interrupt for cleanup only',
            'human_answer_supplied':False,'request_id':observer.blocking['id']}
   rpc.call('turn/interrupt',{'threadId':observer.blocking['params']['threadId'],'turnId':turn},timeout=15)
   pending,rpc.pending=rpc.pending,[]
   for event in pending:observe(event)
   deadline=time.monotonic()+cleanup_timeout
   if observer.completed:break
  remaining=deadline-time.monotonic()
  if remaining<=0:raise TimeoutError('Turn deadline; partial evidence retained, no retry')
  # queue.Empty intentionally propagates as timeout; never busy poll.
  observe(rpc.next(timeout=remaining))
 native=observer.completed['status']
 if not observer.blocking and native!='completed':raise ProtocolError('Unexpected native turn status '+native)
 return {'status':'awaiting_user' if observer.blocking else native,'native_turn_status':native,
         'requests':observer.requests,'cleanup':cleanup,'events':observer.events}

def turn_outcomes(events):
 """Observe native completion and explicit final text separately; never grade quality."""
 completed=set();finals={}
 for event in events:
  p=event.get('params') or {};tid=turn_id(event)
  if event.get('method')=='turn/completed' and (p.get('turn') or {}).get('status')=='completed':
   completed.add(tid)
  item=p.get('item') or {}
  if (event.get('method')=='item/completed' and item.get('type')=='agentMessage'
      and item.get('phase')=='final_answer' and isinstance(item.get('text'),str) and item['text'].strip()):
   finals.setdefault(tid,set()).add(item.get('id') or '<unidentified-final-item>')
 return {'native_completed_turns':len(completed),'native_completed_turn_ids':sorted(completed),
         'turns_with_observed_final_answer':len(finals),'observed_final_answer_turn_ids':sorted(finals),
         'observed_final_answer_item_ids':sorted({item for items in finals.values() for item in items}),
         'native_completed_turns_without_observed_final_answer':len(completed-set(finals)),
         'answer_presence_is_quality_grade':False}

def account_events(events,pricing=None):
 """Deduplicate response IDs; unfinished generation is a lower bound, not zero.

Native has no raw response-start event. Assistant raw items after the last raw
completion are positive evidence of at least one unfinished response. Parallel
calls between completions occupy one response segment. A turn interrupted before
any assistant item is conservatively unresolved too. Native cumulative usage is
reported as evidence, never substituted for missing response completion usage.
 """
 responses={};pending={};turns={};latest=None;seen_items=set()
 for e in events:
  method=e.get('method');p=e.get('params') or {};tid=turn_id(e)
  if method=='turn/started':turns[tid]='inProgress'
  if method=='turn/completed':turns[tid]=p['turn']['status']
  if method=='rawResponseItem/completed':
   item=p.get('item') or {};kind=item.get('type')
   generated=kind in {'function_call','custom_tool_call','reasoning'} or (kind=='message' and item.get('role')=='assistant')
   identity=(tid,item.get('id') or item.get('call_id'))
   if generated and (identity[1] is None or identity not in seen_items):
    pending.setdefault(tid,set()).add(identity[1] or '<unidentified>');seen_items.add(identity)
  if method=='rawResponse/completed':
   rid=p.get('responseId')
   if not rid:raise ProtocolError('Missing response identity')
   record={'turn_id':tid,'usage':p.get('usage')}
   if rid in responses and responses[rid]!=record:raise ProtocolError('Conflicting duplicate response '+rid)
   if rid not in responses:
    responses[rid]=record;pending.pop(tid,None)
  if method=='thread/tokenUsage/updated':latest=(p.get('tokenUsage') or {}).get('total')
 unfinished=[{'turn_id':tid,'observed_assistant_items':sorted(items),'minimum_responses':1,'usage':None,'cost_usd':None}
             for tid,items in pending.items()]
 unresolved=[{'turn_id':tid,'native_status':status,'possible_unfinished_generation':True,
              'usage':None,'cost_usd':None,'limitation':'No completed native turn; no raw item proves an additional generation began'}
             for tid,status in turns.items() if status!='completed' and tid not in pending]
 def valid_usage(usage):
  return (isinstance(usage,dict) and all(type(usage.get(k)) is int and usage[k]>=0 for k in FIELDS)
          and usage['cachedInputTokens']<=usage['inputTokens'] and usage['reasoningOutputTokens']<=usage['outputTokens']
          and usage['totalTokens']==usage['inputTokens']+usage['outputTokens'])
 invalid=[rid for rid,r in responses.items() if not valid_usage(r['usage'])]
 valid=[r for rid,r in responses.items() if rid not in invalid]
 usage={k:sum(r['usage'][k] for r in valid) for k in FIELDS}
 complete=not unfinished and not unresolved and not invalid
 costs=None
 if pricing and not invalid:
  def cost(r):
   u=r['usage'];long=u['inputTokens']>pricing['long_context_threshold']
   inf=Decimal(str(pricing['long_input_multiplier'])) if long else Decimal(1)
   outf=Decimal(str(pricing['long_output_multiplier'])) if long else Decimal(1)
   return (((u['inputTokens']-u['cachedInputTokens'])*Decimal(str(pricing['input']))+
      u['cachedInputTokens']*Decimal(str(pricing['cached'])))*inf+
      u['outputTokens']*Decimal(str(pricing['output']))*outf)/Decimal(1000000)
  if any(r['usage']['cacheWriteInputTokens'] for r in valid):complete=False
  else:costs=str(sum((cost(r) for r in valid),Decimal(0)))
 return {'completed_responses':len(responses),'responses':responses,'completed_usage':usage,
         'invalid_usage_response_ids':invalid,'unfinished_generations_minimum':len(unfinished),
         'unfinished_generations':unfinished,'unresolved_turns':unresolved,'accounting_complete':complete,
         'native_cumulative_usage':latest,'completed_usage_equals_native':None if latest is None else latest==usage,
         'completed_response_cost_usd':costs,'total_cost_usd':costs if complete else None,
         'cost_status':'unknown: unfinished/missing usage' if not complete else ('unpriced' if pricing is None else 'complete'),
         'cache_limitation':'Service prefix cache cannot be manually cleared; observe cached input per response; no all-turn zero-cache claim'}
