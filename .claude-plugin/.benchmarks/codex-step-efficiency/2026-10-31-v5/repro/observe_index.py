"""Read-only live index identity + conservative worker observation; never model/index/mutate."""
import argparse,hashlib,json,os,shlex,subprocess,sys,time
from pathlib import Path
import transport_probe as probe

def main():
 p=argparse.ArgumentParser();p.add_argument('--base',type=Path,required=True);args=p.parse_args();base=args.base.resolve();out=base/'live-index-worker-observation.json';assert not out.exists();assert not(base/'runs').exists() and not(base/'ROOTGO.json').exists()
 cfg=json.loads((base/'proxy-proof-A.json').read_text());probe.BASE=base;env={'PATH':'/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin:/opt/homebrew/bin:/usr/bin:/bin','HOME':'/Users/artk0re','LANG':'en_US.UTF-8','ASDF_NODEJS_VERSION':'24.15.0',**cfg['upstream_env']};wire=probe.Wire('readonly-index',cfg['upstream_command'],env)
 try:
  tools=wire.call('tools/list',{})['result']['tools'];names={t['name'] for t in tools};status_tool='get_index_status';assert status_tool in names,'Current native status tool missing; do not fake status'
  schema=next(t for t in tools if t['name']==status_tool)['inputSchema'];assert 'project' in schema.get('properties',{}) and 'path' in schema.get('properties',{})
  request={'project':probe.PROJECT,'path':probe.REPO};raw=wire.call('tools/call',{'name':status_tool,'arguments':request});assert not raw.get('error') and not raw.get('result',{}).get('isError');status=probe.answer(raw)
 finally:wire.close()
 private=base/'private';private.mkdir(exist_ok=True);rawpath=private/'live-index-status-response.json';rawpath.write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
 # Read process arguments in-memory; persist only process identities and interpreter/worker paths,
 # never arbitrary arguments or environment (which may contain credentials).
 lines=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,args='],text=True).splitlines();workers=[]
 markers=('index-codebase','index-worker','indexer-worker','index-progress','worker-entry','worker-bootstrap')
 for line in lines:
  parts=line.strip().split(None,2)
  if len(parts)!=3 or not any(m in parts[2] for m in markers):continue
  try:tokens=shlex.split(parts[2])
  except ValueError:tokens=[]
  paths=[t for t in tokens if t.endswith(('.js','.ts','.mjs')) and ('/build/' in t or '/src/' in t)]
  workers.append({'pid':int(parts[0]),'ppid':int(parts[1]),'executable':Path(tokens[0]).name if tokens else None,'worker_entry_paths':paths,'matching_markers':[m for m in markers if m in parts[2]],'scope':'Process observation only; does not prove work executing or absence of other worker types'})
 build=(base/'snapshot-build.log').read_text();manifest=json.loads((base/'final-manifest.json').read_text());record={'observed_at_unix':time.time(),'model_turns':0,'read_only':True,'request':request,'tool':status_tool,'schema':schema,'status':status,'raw_private_response':str(rawpath),'raw_sha256':hashlib.sha256(rawpath.read_bytes()).hexdigest(),'worker_process_observations':workers,'build_sweep_scope':{'entry_script_prefix':str(base/'final-runtime/build')+'/','frozen_source_script_sha256':hashlib.sha256((base/'final-runtime/scripts/prebuild-worker-sweep.ts').read_bytes()).hexdigest(),'proof':'repoRoot derives from frozen script import.meta.url; sweep receives only frozen build entryScriptPrefix','stopped_orphan_log_lines':sum('[prebuild] stopped orphaned' in l for l in build.splitlines())},'source_commit':manifest['source_commit'],'corpus_commit':manifest['corpus_commit'],'limitations':['Live shared index/services are not byte-frozen; no cache or neighbor isolation claim.','Status and ps are observations at this instant; root rechecks before launch as needed.','No index_codebase/sweep/doctor mutation was requested.','Process markers are conservative and may include supervising commands, not necessarily active workers.']};out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'evidence':str(out),'status_top_keys':list(status) if isinstance(status,dict) else type(status).__name__,'observed_matching_processes':len(workers),'build_sweep_stopped_orphans':record['build_sweep_scope']['stopped_orphan_log_lines'],'model_turns':0}))
if __name__=='__main__':main()
