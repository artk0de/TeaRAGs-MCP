"""Freeze prepared runtime/homes. Does not start a model turn."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from codex61_app_rpc import RPC,config,CODEX,NODE,REPO
from codex61_runner import BASE,ROOT,OPENING,inventory,sha

def environment(home):
    return {'PATH':str(Path(NODE).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'HOME':'/Users/artk0re','CODEX_HOME':str(home),'ASDF_NODEJS_VERSION':'24.15.0','LANG':'en_US.UTF-8'}

def setup(home,cell,tag):
    assert not home.exists(),'Fresh home only'
    config(home,plugin_root=home/'plugins/cache/tea-rags' if cell=='A' else None)
    extra={}
    if cell=='A':
        env=environment(home)
        subprocess.run([CODEX,'plugin','marketplace','add',str(BASE/'final-marketplace'),'--json'],env=env,cwd=REPO,check=True,capture_output=True)
        subprocess.run([CODEX,'plugin','add','tea-rags@tea-rags','--json'],env=env,cwd=REPO,check=True,capture_output=True)
        version=json.loads((BASE/'final-marketplace/harness/codex/tea-rags/.codex-plugin/plugin.json').read_text())['version']
        plugin=home/('plugins/cache/tea-rags/tea-rags/'+version)
        source=BASE/'final-marketplace/harness/codex/tea-rags'
        assert inventory(plugin)==inventory(source),'Installed plugin differs from final shipped files'
        transport=BASE/('bin-'+tag);transport.mkdir()
        cfg=BASE/('proxy-'+tag+'.json')
        prototype=json.loads((BASE/'upstream-template.json').read_text())
        prototype['forensic_dir']=str(BASE/'private'/('forensic-'+tag))
        prototype['upstream_command']=[NODE,str(BASE/'final-runtime/build/cli/index.js'),'server']
        prototype['audit_log']=str(BASE/('proxy-'+tag+'-audit.jsonl'))
        prototype['upstream_stderr_log']=str(BASE/('proxy-'+tag+'-upstream-private-stderr.txt'))
        cfg.write_text(json.dumps(prototype,indent=2))
        shim=transport/'tea-rags'
        shim.write_text('#!/bin/sh\nexport BENCH_MCP_PROXY_CONFIG='+str(cfg)+'\nexec '+str(Path('/opt/homebrew/bin/python3').resolve())+' '+str(ROOT/'.tmp/codex61_cli.py')+' "$@"\n')
        shim.chmod(0o755)
        extra={'PATH':str(transport)+':'+env['PATH'],'BENCH_MCP_PROXY_CONFIG':str(cfg)}
        # Read native fingerprints, then trust exactly the user-authorized,
        # independently reviewed immutable shipped hook definitions.
        rpc=RPC(home,BASE/('hook-hashes-'+tag),extra_env=extra)
        try:hooks=rpc.call('hooks/list',{'cwds':[REPO]})
        finally:rpc.close()
        hs=[h for row in hooks['data'] for h in row['hooks']]
        assert hs and all(h.get('pluginId')=='tea-rags@tea-rags' for h in hs)
        with (home/'config.toml').open('a') as out:
            for h in hs:out.write('\n[hooks.state.'+json.dumps(h['key'])+']\ntrusted_hash = '+json.dumps(h['currentHash'].split('/sha256:')[0])+'\n')
    return extra

def main():
    request=json.loads((BASE/'freeze-request.json').read_text())
    expected=request['source_commit']
    assert request.get('parent_final_build_signal') is True
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==expected
    assert not (BASE/'final-runtime').exists(),'Fresh snapshot only'
    runtime=BASE/'final-runtime';runtime.mkdir()
    for name in ['build','plugins']:shutil.copytree(ROOT/name,runtime/name)
    for name in ['package.json','package-lock.json','.qdrant-required-version']:shutil.copy2(ROOT/name,runtime/name)
    (runtime/'node_modules').symlink_to(ROOT/'node_modules')
    marketplace=BASE/'final-marketplace'
    shutil.copytree(ROOT/'harness/codex/tea-rags',marketplace/'harness/codex/tea-rags')
    (marketplace/'.agents/plugins').mkdir(parents=True)
    catalog=json.loads((ROOT/'.agents/plugins/marketplace.json').read_text());catalog['plugins']=[p for p in catalog['plugins'] if p['name']=='tea-rags']
    (marketplace/'.agents/plugins/marketplace.json').write_text(json.dumps(catalog,indent=2))
    version=json.loads((marketplace/'harness/codex/tea-rags/.codex-plugin/plugin.json').read_text())['version']
    backend={};proof_backend={}
    for cell in ['A','B']:
        backend[cell]=setup(BASE/'homes'/cell,cell,'run-'+cell)
        proof_backend[cell]=setup(BASE/'proof-homes'/cell,cell,'proof-'+cell)
    paths=[ROOT/'.tmp/codex61_app_rpc.py',ROOT/'.tmp/codex61_runner.py',ROOT/'.tmp/codex61_mcp_proxy.py',ROOT/'.tmp/codex61_cli.py',
        BASE/'questions-only.json',BASE/'final-runtime/package.json',BASE/'final-runtime/package-lock.json',BASE/'final-runtime/.qdrant-required-version',BASE/'metadata-table-schemas.json',ROOT/'.tmp/codex61_fixture_proof.py',ROOT/'.tmp/codex61_proxy_proof.py']
    paths += [ROOT/('.tmp/'+name) for name in ['codex61_finalize.py','codex61_final_proof.py','codex61_transport_probe.py',
        'codex61_metrics.py','codex61_context_metrics.py','codex61_metrics_proof.py']]
    for sub in [BASE/'final-runtime/build',BASE/'final-runtime/plugins',BASE/'final-marketplace']:
        paths += [p for p in sub.rglob('*') if p.is_file() and not p.is_symlink()]
    for group in ['homes','proof-homes']:
        for cell in ['A','B']:
            paths.append(BASE/group/cell/'config.toml')
    paths += list(BASE.glob('proxy-*.json'))
    paths += [p for p in BASE.glob('bin-*/*') if p.is_file()]
    source=Path(REPO)
    readable={}
    for base,dirs,files in os.walk(source,followlinks=False):
        dirs[:]=[d for d in dirs if d not in {'.git','.agents','.codex','.claude','docs','specs'}]
        for f in files:
            p=Path(base)/f
            if f=='.git' or f=='.contextignore.local' or f.lower().endswith(('.md','.markdown','.mdx')):continue
            rel=str(p.relative_to(source))
            readable[rel]={'link':str(p.readlink())} if p.is_symlink() else {'bytes':p.stat().st_size,'sha256':sha(p)}
    corpus_file=BASE/'corpus-readable-inventory.json';corpus_file.write_text(json.dumps(readable,sort_keys=True))
    paths.append(corpus_file)
    manifest={'ROOTGO':False,'source_commit':expected,'corpus_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
        'plugin_version':version,'model':'gpt-6.1-sol','reasoning_effort':'medium','parent_final_build_signal':True,
        'independent_security_review':'pending','backend_env':backend,'proof_backend_env':proof_backend,
        'order':['A','B'],'questions_sha256':sha(BASE/'questions-only.json'),'opening_sha256':hashlib.sha256(OPENING.encode()).hexdigest(),
        'source_context':'fresh sequential questions only; no checkpoint/gold/context_added',
        'metadata_boundary':'native filesystem/network enforced; process metadata is not universally isolated. Benchmark argv/environment are explicitly sanitized, prompts are stdin only, auth is only an FS-denied file.',
        'frozen_files':{str(p):sha(p) for p in paths},'corpus_readable_files':len(readable),'corpus_inventory_sha256':sha(corpus_file)}
    (BASE/'final-manifest.json').write_text(json.dumps(manifest,indent=2))
    print('Prepared fresh production+proof A/B homes, immutable manifests, no model turns',flush=True)

if __name__=='__main__':main()
