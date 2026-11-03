#!/opt/homebrew/bin/python3
"""Trusted-config binding around retained validated read-only MCP transport."""
import importlib.util,os,json,sys,time
from pathlib import Path
from policy import load,scope_arguments,sha
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent))
from replay_transform import ReplayTransform

def attach_replay(cfg,module):
 binding=cfg.get('replay')
 if not binding:return
 if binding.get('helper_sha256') and binding['helper_sha256']!=sha(P.parent/'replay_transform.py'):raise RuntimeError('Replay helper changed')
 if binding['case_id'] not in ['F01','F02']:raise RuntimeError('Replay restricted to frozen freshness cases')
 transform=ReplayTransform(actor_id=binding['actor_id'],case_id=binding['case_id'],project=cfg['project'],fixture_root=cfg['fixture'])
 filtered=module.filtered_response
 def delivery(message,request):
  output=filtered(message,request)
  if request.get('method')!='tools/call' or output.get('error') or output.get('result',{}).get('isError'):return output
  args=request.get('_benchmark_forwarded_arguments')
  if not isinstance(args,dict):raise RuntimeError('Actual forwarded arguments missing; replay cannot reconstruct request')
  name=request.get('params',{}).get('name')
  changed,audit=transform.apply(output.get('result'),tool=name,arguments=args)
  selectors=['project','path','relativePath','symbols','symbol','symbolId','metaOnly']
  requested=request.get('params',{}).get('arguments',{})
  audit.update(request_id=request.get('id'),unix_time=time.time(),requested_locators={k:requested[k] for k in selectors if k in requested},forwarded_locators={k:args[k] for k in selectors if k in args})
  log=Path(binding['audit_log']);log.parent.mkdir(parents=True,exist_ok=True)
  with log.open('a') as f:f.write(json.dumps(audit,ensure_ascii=False)+'\n');f.flush()
  # Persist safe provenance before returning bytes to the native transport.
  output['result']=changed
  return output
 module.filtered_response=delivery


def configured(config=None):
 cfg=load(config or os.environ['BENCH_MCP_PROXY_CONFIG'])
 for k in ['fixture','project','collection','upstream_command','upstream_env','audit_log','forensic_dir','upstream_stderr_log']:
  if not cfg.get(k):raise RuntimeError('Missing trusted proxy configuration: '+k)
 spec=importlib.util.spec_from_file_location('validated_scoped_proxy',P/'validated/codex61_mcp_proxy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 m.REPO=str(Path(cfg['fixture']).resolve());m.PROJECT=cfg['project'];m.COLLECTION=cfg['collection'];original=m.guard_call
 m.guard_call=lambda name,args:original(name,scope_arguments(name,args,cfg))
 attach_replay(cfg,m)
 if cfg['upstream_env'].get('TEA_RAGS_AUTO_UPDATE')!='0':raise RuntimeError('Client auto-update must be disabled')
 return cfg,m
if __name__=='__main__':configured()[1].main()
