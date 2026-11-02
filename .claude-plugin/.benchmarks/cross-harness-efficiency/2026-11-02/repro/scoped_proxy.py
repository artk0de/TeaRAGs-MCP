#!/opt/homebrew/bin/python3
"""Trusted-config binding around retained validated read-only MCP transport."""
import importlib.util,os
from pathlib import Path
from policy import load,scope_arguments
P=Path(__file__).resolve().parent

def configured(config=None):
 cfg=load(config or os.environ['BENCH_MCP_PROXY_CONFIG'])
 for k in ['fixture','project','collection','upstream_command','upstream_env','audit_log','forensic_dir','upstream_stderr_log']:
  if not cfg.get(k):raise RuntimeError('Missing trusted proxy configuration: '+k)
 spec=importlib.util.spec_from_file_location('validated_scoped_proxy',P/'validated/codex61_mcp_proxy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 m.REPO=str(Path(cfg['fixture']).resolve());m.PROJECT=cfg['project'];m.COLLECTION=cfg['collection'];original=m.guard_call
 m.guard_call=lambda name,args:original(name,scope_arguments(name,args,cfg))
 if cfg['upstream_env'].get('TEA_RAGS_AUTO_UPDATE')!='0':raise RuntimeError('Client auto-update must be disabled')
 return cfg,m
if __name__=='__main__':configured()[1].main()
