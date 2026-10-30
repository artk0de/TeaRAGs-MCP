#!/usr/bin/env python3
import json
import hashlib
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import time

ROOT=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp')
BASE=ROOT/'.tmp/codex-q24-20261030-050614'
OUT=ROOT/'research/codex-q03-tool-replay-2026-10-30'
REPO='/Users/Shared/nav-ab/repo-master'

def run(variant):
    OUT.mkdir(exist_ok=True)
    env=dict(os.environ)
    config=(BASE/'mcp-template.toml').read_text().split('[mcp_servers.tea-rags.env]',1)[1]
    for line in config.splitlines():
        m=re.match(r'^([A-Z_]+)\s*=\s*(".*")\s*$',line)
        if m: env[m[1]]=json.loads(m[2])
    runtime=BASE/'runtime/build/cli/index.js' if variant=='old' else ROOT/'build/cli/index.js'
    err=(OUT/f'{variant}-stderr.txt').open('w')
    p=subprocess.Popen(['/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin/node',str(runtime),'server'],
        cwd=REPO,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1)
    request_id=0
    def request(method,params=None):
        nonlocal request_id
        request_id+=1
        msg={'jsonrpc':'2.0','id':request_id,'method':method}
        if params is not None: msg['params']=params
        p.stdin.write(json.dumps(msg)+'\n'); p.stdin.flush()
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            readable,_,_=select.select([p.stdout],[],[],1)
            if not readable:
                if p.poll() is not None: raise RuntimeError(f'server exited {p.returncode}')
                continue
            line=p.stdout.readline()
            if not line:
                raise RuntimeError(f'server stdout closed, exit {p.poll()}')
            try: result=json.loads(line)
            except json.JSONDecodeError: continue
            if result.get('id')==request_id: return result
        raise TimeoutError(method)
    try:
        init=request('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'q03-direct-replay','version':'1.0'}})
        p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n'); p.stdin.flush()
        tool_list=request('tools/list',{})
        tools=tool_list.get('result',{}).get('tools',[])
        assert any(t.get('name')=='find_symbol' for t in tools), 'find_symbol unavailable'
        (OUT/f'{variant}-readiness.json').write_text(json.dumps({'initialize':init,'tool_count':len(tools),
            'tool_names':[t['name'] for t in tools],'tools_list_sha256':hashlib.sha256(json.dumps(tool_list,sort_keys=True).encode()).hexdigest()},indent=2))
        listing=request('tools/call',{'name':'list_projects','arguments':{}})
        # Keep registry/config output outside the research archive.
        (BASE/f'q03-{variant}-projects-private.json').write_text(json.dumps(listing,ensure_ascii=False,indent=2))
        print(variant,'project listing captured privately',flush=True)
        source=Path('/Users/artk0re/Dev/bench-private/taxdome/planning/runs/A-m53-sbx-nohist-bare/transcript.jsonl')
        events=[json.loads(x) for x in source.read_text().splitlines()]
        args=next(b['input'] for b in events[110]['message']['content'] if b.get('type')=='tool_use')
        projects=json.loads(listing['result']['content'][0]['text'])['projects']
        alias=next(r[0] for r in projects['rows'] if r[1]==REPO)
        args={**args,'path':REPO,'project':alias}
        smoke=request('tools/call',{'name':'find_symbol','arguments':{'project':alias,'path':REPO,'relativePath':'app/lib/tax_preparation/tax_automations/registry.rb'}})
        (OUT/f'{variant}-smoke.json').write_text(json.dumps(smoke,ensure_ascii=False,indent=2))
        assert not smoke.get('error') and not smoke.get('result',{}).get('isError'), 'source smoke failed'
        assert smoke.get('result',{}).get('structuredContent',{}).get('results'), 'source smoke returned no source'
        # Original registered alias plus explicit snapshot path addresses this checkout.
        (OUT/f'{variant}-request.json').write_text(json.dumps(args,ensure_ascii=False,indent=2))
        started=time.monotonic()
        result=request('tools/call',{'name':'find_symbol','arguments':args})
        wall=time.monotonic()-started
        raw=json.dumps(result,ensure_ascii=False,indent=2)
        (OUT/f'{variant}-response.json').write_text(raw)
        continuation=request('tools/call',{'name':'find_symbol','arguments':{'project':alias,'path':REPO,
            'symbols':['app/services/tax_preparation/tax_automations/instead/clients/link_entity_by_name.rb']}})
        (OUT/f'{variant}-continuation.json').write_text(json.dumps(continuation,ensure_ascii=False,indent=2))
        (OUT/f'{variant}-status.json').write_text(json.dumps({'wall_seconds':round(wall,3),'runtime':str(runtime),
            'original_source_line':111,'repo':REPO,'raw_response_chars':len(raw),'server_info':init.get('result',{}).get('serverInfo')},indent=2))
        print(variant,'completed',round(wall,3),'seconds',len(raw),'response chars',flush=True)
    finally:
        p.terminate()
        try: p.wait(timeout=10)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        err.close()

if __name__=='__main__': run(sys.argv[1])
