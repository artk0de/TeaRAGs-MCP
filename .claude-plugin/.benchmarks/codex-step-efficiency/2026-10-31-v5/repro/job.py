"""Explicit future A-only job; no launch on import and no default historical base."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from controller_io import require_controller_python, verify_runtime


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base',type=Path,required=True)
    args=parser.parse_args();base=args.base.resolve();here=Path(__file__).resolve().parent
    require_controller_python()
    verify_runtime(json.loads((base/'final-manifest.json').read_text())['controller_python'])
    status=base/'root-job-status.json'
    with status.open('x') as stream:
        json.dump({'status':'launching','conditions':['A'],'retries':0},stream)
    proc=subprocess.run([sys.executable,str(here/'run.py'),'--base',str(base),'--rootgo'])
    result={'condition':'A','actor_returncode':proc.returncode,'retries':0,'quality':'NOT GRADED'}
    if proc.returncode==0:
        collect=subprocess.run([sys.executable,str(here/'collect.py'),'--base',str(base),'--pricing',str(base/'verified-api-pricing.json'),'--output',str(base/'completed-accounting.json')])
        result.update(status='finished' if collect.returncode==0 else 'accounting_failed',collector_returncode=collect.returncode)
    else:
        result.update(status='failed',limitation='Partial evidence retained; no retry; incomplete cost unknown')
    status.write_text(json.dumps(result,indent=2)+'\n')
    return collect.returncode if proc.returncode == 0 else proc.returncode

if __name__=='__main__':raise SystemExit(main())
