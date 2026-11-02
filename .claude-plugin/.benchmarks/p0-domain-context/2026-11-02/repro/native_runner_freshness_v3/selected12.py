"""Root-authorized new freshness condition only; old baseline Codex never reruns."""
import argparse,json,time
from pathlib import Path
import run
KEYS=['baseline-claude-F01','baseline-claude-D01','baseline-claude-D02','baseline-claude-F02','candidate-claude-D01','candidate-claude-D02','candidate-claude-F01','candidate-claude-F02','candidate-codex-D01','candidate-codex-D02','candidate-codex-F01','candidate-codex-F02']
def check_selected(keys):
 if keys!=KEYS:raise PermissionError('Exact selected12 order with baselineClaudeF01 actual-execution gate required')
def mode_denials(events):return [e.get('tool_name') for e in events if e.get('type')=='system' and e.get('subtype')=='permission_denied' and e.get('decision_reason_type')=='mode' and str(e.get('tool_name','')).startswith('mcp__')]
def check_native_execution(events,audit,scope):
 if mode_denials(events):raise RuntimeError('Native mode still denies MCP; retain billable attempt and stop')
 target=set();succeeded=set()
 for e in events:
  if e.get('type')=='assistant':
   for b in e.get('message',{}).get('content',[]):
    if isinstance(b,dict) and b.get('type')=='tool_use' and b.get('name')=='mcp__tea-rags__find_symbol':
     a=b.get('input',{})
     if a.get('relativePath')=='src/refund-settlement/status.ts' and a.get('project',scope['project'])==scope['project'] and a.get('path',scope['fixture'])==scope['fixture']:target.add(b['id'])
  elif e.get('type')=='user':
   for b in e.get('message',{}).get('content',[]):
    if isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id') in target and not b.get('is_error') and 'refund_settlement' in json.dumps(b.get('content')):succeeded.add(b['tool_use_id'])
 applied=[a for a in audit if a.get('status')=='applied' and a.get('forwarded_locators',{}).get('project')==scope['project'] and a.get('forwarded_locators',{}).get('path')==scope['fixture']]
 if not succeeded or not applied or any(a.get('status')=='unexercised' for a in audit):raise RuntimeError('Actual successful scoped native MCP result and eligible replay delivery required; catalog or Read fallback is insufficient')
 return {'status':'ACTUAL_NATIVE_EXECUTION_PASS','successful_target_tool_ids':sorted(succeeded),'native_mode_denials':0,'eligible_deliveries':len(applied),'limits':'Observed real native call/result after unchanged literal user prompt; no separate diagnostic model actor.'}
def execute(out,go_path,native_go):
 out=Path(out).resolve();go=run.load(go_path);check_selected(go.get('selected_keys'));run.stop_check(out);seal=run.load(out/'seal.json');schedule=run.checked_schedule(out,seal)
 if not set(KEYS).issubset({j['key'] for j in schedule}) or go.get('execute_actor_count')!=12:raise PermissionError('Selected matrix mismatch')
 for key in KEYS:run.authorize(go,seal,key)
 run.publish(out/'SELECTED-RUN-STARTED.json',{'selected_keys':KEYS,'actors':12,'rootgo_sha256':run.sha(go_path),'entrypoint_sha256':run.sha(__file__),'concurrency':1});completed=[]
 for key in KEYS:
  started=time.time();print(json.dumps({'phase':'start','key':key,'completed':len(completed),'unix_time':started}),flush=True)
  try:
   run.prove(out,key,native_go);run.run_one(out,key,go_path);actor=out/'actors'/key
   if '-claude-' in key:
    events=[json.loads(line) for line in (actor/'native/events.jsonl').open()]
    if mode_denials(events):raise RuntimeError('Native mode permission failure; stop remaining')
    if not completed:
     p=run.load(out/'profiles'/key/'profile.json');audit_path=out/'profiles'/key/'replay-audit.jsonl';audit=[json.loads(x) for x in audit_path.open()] if audit_path.is_file() else [];gate=check_native_execution(events,audit,p['guard']);gate['events_sha256']=run.sha(actor/'native/events.jsonl');gate['replay_audit_sha256']=run.sha(audit_path);run.publish(out/'ACTUAL-NATIVE-EXECUTION-GATE.json',gate)
   completed.append(key);result=run.load(actor/'result.json');print(json.dumps({'phase':'completed','key':key,'completed':len(completed),'responses':result['model_response_count'],'replay':result['replay_delivery']['status'],'elapsed_seconds':time.time()-started}),flush=True)
  except BaseException as e:
   failure={'key':key,'status':'failed','completed_keys':completed,'retry':False,'error_type':type(e).__name__}
   if not (out/'STOP.json').exists():run.publish(out/'STOP.json',failure)
   print(json.dumps(failure),flush=True);raise
 run.publish(out/'SELECTED-RUN-COMPLETED.json',{'actors':len(completed),'completed_keys':completed,'quality':'UNGRADED','prior_original_baseline_codex':'Immutable referenced results, not new actors.'})
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);p.add_argument('--rootgo',type=Path,required=True);p.add_argument('--native-go',type=Path,required=True);a=p.parse_args();execute(a.out,a.rootgo,a.native_go)
