#!/usr/bin/env python3
"""Offline final-visible-output timing; never accesses private reasoning fields."""
import json,hashlib,collections,re,unittest,sys
from analyze import ROOT,OUT,length,clipped
BASE=OUT/'accounting.json'
def residual(intervals,a,b):return (b-a)/1000-length(clipped(intervals,a,b))
def schema(obj,path=''):
 """Only field paths. Replace attribution item IDs with a wildcard; no values."""
 out=set()
 if isinstance(obj,dict):
  for k,v in obj.items():
   key='*' if path.endswith('attribution.items') else k
   p=path+'.'+key if path else key;out.add(p);out.update(schema(v,p))
 elif isinstance(obj,list):
  for v in obj:out.update(schema(v,path+'[]'))
 return out
class Tests(unittest.TestCase):
 def test_partition_parallel(self):
  v=[(0,2000),(1000,3000),(8000,9000)];parts=[residual(v,0,5000),residual(v,5000,9500),residual(v,9500,10000)];self.assertAlmostEqual(sum(parts),6)
 def test_metadata_redaction(self):self.assertEqual(schema({'attribution':{'items':{'opaque-id':{'output_tokens':1}}}}),{'attribution','attribution.items','attribution.items.*','attribution.items.*.output_tokens'})
def main():
 original_hash=hashlib.sha256(BASE.read_bytes()).hexdigest();base=json.loads(BASE.read_text());result={'base_accounting_sha256':original_hash,'limitations':['First visible output means first nonempty agentMessage delta notification, not server first token. Notification buffering/network/client effects remain.','Observed stream duration runs from first nonempty delta to final agentMessage completion; output minus reasoning token throughput is an approximate visible-token proxy, not server generation speed.','No response request-start timestamp or explicit server latency metrics; pre-output residual includes model/network/client/queue work.'],'runs':{}}
 for label,run in base['runs'].items():
  rows=[];paths=set();responsecount=0
  for q in run['questions']:
   raw=(ROOT/q['source']).read_bytes();assert hashlib.sha256(raw).hexdigest()==q['sha256'],(label,q['id'],'raw source fingerprint');es=json.loads(raw);items={};deltas=collections.defaultdict(list)
   for n,e in enumerate(es):
    p=e['params'];method=e['method']
    if method=='rawResponse/completed':paths.update(schema(p.get('usageMetadata',{})));responsecount+=1
    if method=='item/completed' and p['item']['type']=='agentMessage':items[p['item']['id']]=p['item']
    if method=='item/agentMessage/delta' and p.get('delta'):
     deltas[p['itemId']].append((e['emittedAtMs'],len(p['delta'].encode('utf-8')),n))
   finals=[r for r in q['responses'] if r['category']=='final'];assert len(finals)==1
   r=finals[0];ids=[i['id'] for i in r['items'] if i['type']=='message' and items.get(i['id'],{}).get('phase')=='final_answer'];assert len(ids)==1
   id=ids[0];item=items[id];ds=deltas[id];row={'question_id':q['id'],'response_id':r['id'],'item_id':id,'source_sha256':q['sha256'],'response_interval_start_ms':r['interval_start_ms'],'response_completed_ms':r['completed_ms'],'final_residual_seconds':r['model_network_client_residual_seconds'],'delta_count':len(ds),'nonreasoning_output_token_proxy':r['usage']['outputTokens']-r['usage'].get('reasoningOutputTokens',0),'reasoning_output_token_count':r['usage'].get('reasoningOutputTokens',0)}
   if not ds:row['observability']='No nonempty visible delta; split unavailable';rows.append(row);continue
   first,last=ds[0][0],ds[-1][0];end=item['completedAtMs'];start=item['startedAtMs'];assert r['interval_start_ms']<=first<=last<=end<=r['completed_ms']
   ints=q['runtime_union_intervals_ms'];pre=residual(ints,r['interval_start_ms'],first);stream=residual(ints,first,end);tail=residual(ints,end,r['completed_ms']);assert abs(pre+stream+tail-r['model_network_client_residual_seconds'])<1e-7
   delta_bytes=sum(d[1] for d in ds);finalbytes=len(item.get('text','').encode('utf-8'));assert delta_bytes==finalbytes,(label,q['id'],'visible delta byte reconciliation')
   row.update({'observability':'Available','agent_item_start_ms':start,'first_visible_delta_ms':first,'last_visible_delta_ms':last,'agent_item_completed_ms':end,'first_delta_event_index':ds[0][2],'last_delta_event_index':ds[-1][2],'pre_visible_residual_seconds':pre,'visible_stream_residual_seconds':stream,'post_message_residual_seconds':tail,'observed_visible_stream_seconds':(end-first)/1000,'first_to_last_delta_seconds':(last-first)/1000,'agent_start_to_first_delta_seconds':(first-start)/1000,'visible_utf8_bytes':finalbytes,'approx_visible_tokens_per_observed_stream_second':row['nonreasoning_output_token_proxy']/((end-first)/1000) if end>first else None,'visible_bytes_per_observed_stream_second':finalbytes/((end-first)/1000) if end>first else None});rows.append(row)
  totals={k:sum(q.get(k,0) for q in rows) for k in ['final_residual_seconds','pre_visible_residual_seconds','visible_stream_residual_seconds','post_message_residual_seconds','observed_visible_stream_seconds','first_to_last_delta_seconds','agent_start_to_first_delta_seconds','visible_utf8_bytes','delta_count','nonreasoning_output_token_proxy','reasoning_output_token_count']};totals['approx_visible_tokens_per_observed_stream_second']=totals['nonreasoning_output_token_proxy']/totals['observed_visible_stream_seconds'];totals['visible_bytes_per_observed_stream_second']=totals['visible_utf8_bytes']/totals['observed_visible_stream_seconds'];totals['available_questions']=sum(q['observability']=='Available' for q in rows)
  metricpaths=[p for p in paths if re.search(r'latenc|queue|service.?tier|duration|first.?token|processing|timing',p,re.I)]
  result['runs'][label]={'usage_metadata_response_count':responsecount,'usage_metadata_schema_paths':sorted(paths),'latency_service_tier_queue_metric_paths':metricpaths,'totals':totals,'questions':rows}
 result['comparisons']={ref:{k:result['runs']['latest_A']['totals'][k]-result['runs'][ref]['totals'][k] for k in ['final_residual_seconds','pre_visible_residual_seconds','visible_stream_residual_seconds','post_message_residual_seconds','observed_visible_stream_seconds','nonreasoning_output_token_proxy','visible_utf8_bytes']} for ref in ['reference_B','previous_A']}
 assert hashlib.sha256(BASE.read_bytes()).hexdigest()==original_hash
 (OUT/'timing-refinement.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:r['totals'] for k,r in result['runs'].items()},indent=2));print(json.dumps(result['comparisons'],indent=2));print('metric paths', {k:r['latency_service_tier_queue_metric_paths'] for k,r in result['runs'].items()})
if __name__=='__main__':
 if '--test' in sys.argv:unittest.main(argv=[sys.argv[0]])
 else:main()
