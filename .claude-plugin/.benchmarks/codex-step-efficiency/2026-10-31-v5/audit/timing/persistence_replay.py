#!/usr/bin/env python3
"""Offline faithful frozen callback replay. Never launches RPC/models or edits inputs."""
import json,time,pathlib,tempfile,hashlib,collections,sys,ast,queue,threading,unittest,platform
from analyze import ROOT,OUT
BASE=json.loads((OUT/'accounting.json').read_text())
# Extract only frozen dump's AST; do not import/execute runner module.
runner=ROOT/BASE['runs']['latest_A']['source'].split('/runs/')[0]/'lib/codex61_runner.py'
mod=ast.parse(runner.read_text());node=next(x for x in mod.body if isinstance(x,ast.FunctionDef) and x.name=='dump');env={'Path':pathlib.Path,'json':json};exec(compile(ast.Module(body=[node],type_ignores=[]),str(runner),'exec'),env);dump=env['dump']
def inventory(events):
 # Exact indent=2 serialization sizes without repeatedly serializing every prefix.
 sizes=[len(('  '+json.dumps(e,ensure_ascii=False,indent=2).replace('\n','\n  ')).encode()) for e in events]
 n=len(events);cumulative=sum((n-i)*v for i,v in enumerate(sizes))+n*5+n*(n-1)
 final=5+sum(sizes)+2*(n-1) if n else len('[]\n')
 assert final==len((json.dumps(events,ensure_ascii=False,indent=2)+'\n').encode())
 return {'event_count':n,'delta_count':sum(e.get('method')=='item/agentMessage/delta' for e in events),'final_bytes':final,'cumulative_bytes_rewritten':cumulative,'method_counts':dict(collections.Counter(e.get('method') for e in events))}
def direct(events,dest):
 observed=[];phases=collections.Counter();cpu=time.process_time();wall=time.perf_counter()
 finalid=next(e['params']['item']['id'] for e in events if e.get('method')=='item/completed' and e['params']['item'].get('phase')=='final_answer')
 final_indices=[n for n,e in enumerate(events) if e.get('method')=='item/agentMessage/delta' and e['params'].get('itemId')==finalid and e['params'].get('delta')]
 first=final_indices[0];last=next(n for n,e in enumerate(events) if e.get('method')=='item/completed' and e['params']['item'].get('id')==finalid)
 for n,event in enumerate(events):
  a=time.perf_counter();observed.append(event);dump(dest,observed);phases['final_stream_persistence_seconds' if first<=n<=last else 'other_persistence_seconds']+=time.perf_counter()-a
 result={'wall_seconds':time.perf_counter()-wall,'cpu_seconds':time.process_time()-cpu,'phase_wall_seconds':dict(phases)};expected=(json.dumps(events,ensure_ascii=False,indent=2)+'\n').encode();assert dest.read_bytes()==expected;result['final_body_fidelity']='byte-for-byte equal to frozen dump(events)';return result
def reader_replay(events,dest,rawpath,persist):
 # In-memory historical JSONL feeds a background reader mirroring original reader.
 # Unbounded queue matches original. No source-paced sleeps, live RPC or actor.
 lines=[json.dumps(e,ensure_ascii=False)+'\n' for e in events];q=queue.Queue();stats={};observed=[]
 def reader():
  a=time.perf_counter();last=a;maxgap=0
  with rawpath.open('w') as raw:
   for line in lines:
    raw.write(line);raw.flush();q.put(json.loads(line));now=time.perf_counter();maxgap=max(maxgap,now-last);last=now
  stats.update(reader_wall_seconds=time.perf_counter()-a,max_reader_delivery_gap_seconds=maxgap);q.put(None)
 cpu=time.process_time();wall=time.perf_counter();thread=threading.Thread(target=reader);thread.start()
 while True:
  event=q.get()
  if event is None:break
  observed.append(event)
  if persist:dump(dest,observed)
 thread.join();result={'wall_seconds':time.perf_counter()-wall,'cpu_seconds':time.process_time()-cpu,**stats,'fidelity':observed==events,'persist_enabled':persist}
 assert observed==events
 if persist:assert dest.read_bytes()==(json.dumps(events,ensure_ascii=False,indent=2)+'\n').encode()
 return result
def main():
 file=OUT/'controller-persistence-hypothesis.json';result=json.loads(file.read_text()) if file.exists() else {'source_fingerprints':{},'inventory':{},'replays':[],'limitations':['Replay measures present-machine CPU/filesystem cost, not historical load or server backpressure. No fsync matches actual callback.','Unpaced reader replay uses an in-memory historical JSONL source, not a live RPC; it tests queue/GIL contention but cannot recreate server emission or prove causation.']}
 for name,r in BASE['runs'].items():
  if name not in result['inventory']:
   rows=[]
   for q0 in r['questions']:
    raw=(ROOT/q0['source']).read_bytes();assert hashlib.sha256(raw).hexdigest()==q0['sha256'];ev=json.loads(raw);rows.append({'question_id':q0['id'],'source':q0['source'],'source_sha256':q0['sha256'],**inventory(ev)})
   result['inventory'][name]=rows
  lib=ROOT/r['source'].split('/runs/')[0]/'lib'
  result['source_fingerprints'][name]={n:hashlib.sha256((lib/n).read_bytes()).hexdigest() for n in ['codex61_runner.py','protocol.py','codex61_app_rpc.py']}
 file.write_text(json.dumps(result,indent=2)+'\n')
 result['replay_python']={'executable':sys.executable,'version':sys.version,'platform':platform.platform()};selection=sys.argv[1:] or ['Q01'];reader_mode='--readers' in selection;selection=[s for s in selection if not s.startswith('--')];selection=[f'Q{i:02d}' for i in range(2,40)] if '--rest' in sys.argv else selection
 with tempfile.TemporaryDirectory(prefix='persistence-replay-',dir=OUT) as tmp:
  tmp=pathlib.Path(tmp)
  for qid in selection:
   for name,r in BASE['runs'].items():
    ev=json.loads((ROOT/next(q['source'] for q in r['questions'] if q['id']==qid)).read_text());row={'run':name,'question_id':qid,'mode':'direct',**direct(ev,tmp/'partial.json')};result['replays'].append(row);file.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(row),flush=True)
  if reader_mode:
   for name in ['latest_A','reference_B']:
    ev=json.loads((ROOT/BASE['runs'][name]['questions'][0]['source']).read_text())
    for enabled in [False,True]:
     row={'run':name,'question_id':'Q01','mode':'background_reader',**reader_replay(ev,tmp/'reader-partial.json',tmp/'raw.jsonl',enabled)};result['replays'].append(row);file.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(row),flush=True)
if __name__=='__main__':main()
