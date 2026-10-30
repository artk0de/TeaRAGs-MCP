#!/usr/bin/env python3
"""Transport-only CLI shim for the unchanged Codex plugin command names."""
import json
import os
from pathlib import Path
import subprocess
import sys
from codex61_mcp_proxy import PROJECT,REPO,safe_path,safe_resource

def main():
    cfg_path=os.environ.get('BENCH_MCP_PROXY_CONFIG')
    if not cfg_path:
        raise SystemExit('Scoped MCP transport is available through Codex MCP tools only')
    cfg=json.loads(Path(cfg_path).read_text());args=sys.argv[1:]
    if args==['server']:
        from codex61_mcp_proxy import main as proxy_main
        return proxy_main()
    allowed=False
    if args==['prime','--agent',REPO]:allowed=True
    elif args==['project','exist','--path',REPO,'--repository','--print-name']:allowed=True
    elif len(args)==2 and args[0]=='resource' and safe_resource(args[1]):allowed=True
    elif len(args)>=5 and args[:2]==['project','indexed'] and args[-1]=='--json':
        tail=args[2:-1]
        allowed=len(tail)%2==0 and all(tail[i]=='--path' and safe_path(tail[i+1]) for i in range(0,len(tail),2))
    if not allowed:raise SystemExit('CLI arguments outside the read-only benchmark scope')
    env=dict(cfg['upstream_env'])
    # Private backend stderr never becomes model-facing tool text.
    with Path(cfg['upstream_stderr_log']).open('a') as err:
        p=subprocess.run(cfg['upstream_command'][:-1]+args,cwd=REPO,env=env,stdout=subprocess.PIPE,stderr=err,text=True)
    if p.returncode:
        sys.stderr.write('Scoped read-only CLI command failed; see orchestrator readiness logs.\n')
    else:sys.stdout.write(p.stdout)
    raise SystemExit(p.returncode)

if __name__=='__main__':main()
