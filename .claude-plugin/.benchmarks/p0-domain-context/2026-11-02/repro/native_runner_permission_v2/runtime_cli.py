#!/opt/homebrew/bin/python3
"""Real matching-variant CLI, with trusted read-only argument/scope gate."""
import os,subprocess,sys,json,hashlib,time
from pathlib import Path
from scoped_proxy import configured

def main():
 cfg,p=configured();args=sys.argv[1:];root=str(Path(cfg['fixture']).resolve());ok=False;tool_args=None
 if args==['server']:return p.main()
 if args==['prime','--agent',root]:ok=True
 elif args==['project','exist','--path',root,'--repository','--print-name']:ok=True
 elif len(args)==2 and args[0]=='resource' and p.safe_resource(args[1]):ok=True
 elif len(args)==7 and args[:3]==['project','indexed','--command'] and args[4:]==['--cwd',root,'--json']:
  # Membership lookup parses this opaque command; never execute it as shell code.
  ok=isinstance(args[3],str) and '\x00' not in args[3]
 elif len(args)==5 and args[:2]==['call','find_symbol'] and args[3:]==['--format','json']:
  tool_args=p.guard_call('find_symbol',json.loads(args[2]));args[2]=json.dumps(tool_args);ok=True
 elif len(args)>=5 and args[:2]==['project','indexed'] and args[-1]=='--json':
  rest=args[2:-1];ok=len(rest)%2==0 and all(rest[i]=='--path' and p.safe_path(rest[i+1]) for i in range(0,len(rest),2))
 if not ok:raise SystemExit('Readonly evaluation CLI scope rejected arguments')
 env={**cfg['upstream_env'],'TEA_RAGS_AUTO_UPDATE':'0'}
 if cfg.get('diagnostic_fetch'):
  observer=Path(__file__).with_name('diagnostic_fetch.cjs');env['P0_FETCH_AUDIT']=str(Path(cfg['audit_log']).with_suffix('.fetch-diagnostic.jsonl'));env['NODE_OPTIONS']=(env.get('NODE_OPTIONS','')+' --require '+str(observer)).strip()
 audit=Path(cfg.get('audit_log',str(Path(cfg['upstream_stderr_log']).with_suffix('.audit.jsonl')))).with_suffix('.cli-launch.jsonl');record={'kind':'real_cli_launch','command':cfg['upstream_command'][:-1]+args,'cwd':root,'time_ns':time.time_ns(),'selected_env':{k:env.get(k) for k in ['HOME','QDRANT_URL','TEA_RAGS_DATA_DIR','QDRANT_EMBEDDED_STORAGE_PATH','TEA_RAGS_AUTO_UPDATE']},'diagnostic_fetch':bool(cfg.get('diagnostic_fetch'))}
 with audit.open('a') as log:log.write(json.dumps(record)+'\n')
 with Path(cfg['upstream_stderr_log']).open('a') as err:
  proc=subprocess.run(cfg['upstream_command'][:-1]+args,cwd=root,env=env,stdout=subprocess.PIPE,stderr=err,text=True)
 if proc.returncode:sys.stderr.write('Real scoped CLI failed; controller retains backend diagnostics.\n')
 else:sys.stdout.write(p.parse_tool_text(proc.stdout,'find_symbol',tool_args) if tool_args is not None else proc.stdout)
 return proc.returncode
if __name__=='__main__':raise SystemExit(main())
