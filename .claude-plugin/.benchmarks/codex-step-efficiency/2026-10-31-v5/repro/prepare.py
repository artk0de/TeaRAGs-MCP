#!/usr/bin/env python3
"""Prepare exactly one fresh A39; all RPC clients in this script forbid model turns."""
import hashlib
import importlib
import json
import os
import queue
from pathlib import Path
import shutil
import subprocess
import sys
import time
from controller_io import require_controller_python, verify_runtime

ROOT = Path.cwd()
BASE = None
BASELINE = None
HELPERS = Path(__file__).resolve().parent
OLD = ROOT / ".tmp/codex61"
SOURCE_COMMIT = None
CORPUS_COMMIT = "f88b42f3c286815ea43b464960205d56445ee2e6"
REPO = "/Users/Shared/nav-ab/repo-master"


def dump(path, value):
    path=Path(path)
    temporary=path.with_name(path.name+".writing")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inventory(root):
    root=Path(root)
    assert not root.is_symlink(), 'Plugin root must not be a symlink: '+str(root)
    entries=sorted(root.rglob('*'))
    links=[str(p.relative_to(root)) for p in entries if p.is_symlink()]
    assert not links, 'Plugin symlinks are not allowed: '+repr(links)
    return {str(p.relative_to(root)):sha(p) for p in entries if p.is_file()}


def verify_installed_plugin(plugin,expected):
    actual=inventory(plugin)
    assert actual==expected, 'Native installed file paths/hashes differ from frozen shipped snapshot: '+str(plugin)
    return actual


def verify_native_cli(api,provenance=None):
    provenance=provenance or json.loads((HELPERS/'native-schema-provenance.json').read_text())
    version=subprocess.check_output([api.CODEX,'--version'],text=True).strip()
    assert version==provenance['version'], 'CLI version differs from retained native schema; regenerate/review semantics'
    assert sha(api.CODEX)==provenance['cli_sha256'], 'CLI binary differs from retained native schema; regenerate/review semantics'
    return version


def copy_modules():
    lib=BASE/'lib'; lib.mkdir()
    validated=json.loads((BASELINE/'independent-transport-proof.json').read_text())
    assert sha(BASELINE/'lib/codex61_mcp_proxy.py')==validated['proxy_source_sha256'], 'Baseline proxy differs from validated live transport'
    names=['codex61_app_rpc.py','codex61_mcp_proxy.py','codex61_cli.py','codex61_metrics.py','codex61_context_metrics.py']
    originals={}
    for name in names:
        original=BASELINE/'lib'/name;originals[str(original)]=sha(original)
        shutil.copy2(original,lib/name)
    # Preserve exact validated proxy and table schema, including live upstream sources.
    (lib/'codex61').mkdir()
    schema=BASELINE/'lib/codex61/metadata-table-schemas.json'
    shutil.copy2(schema,lib/'codex61/metadata-table-schemas.json'); originals[str(schema)]=sha(schema)
    for name in ['protocol.py','runner.py','controller_io.py','mcp_readiness.py']:
        target='codex61_runner.py' if name=='runner.py' else name
        shutil.copy2(HELPERS/name,lib/target)
    shutil.copy2(BASELINE/'upstream-template.json',BASE/'upstream-template.json')
    dump(BASE/'original-module-hashes.json',originals)
    sys.path.insert(0,str(lib))
    return importlib.import_module('codex61_app_rpc'),importlib.import_module('codex61_runner')


def environment(api, home):
    return {"PATH": str(Path(api.NODE).parent) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": "/Users/artk0re", "CODEX_HOME": str(home), "ASDF_NODEJS_VERSION": "24.15.0", "LANG": "en_US.UTF-8"}


def plugin_version():
    return json.loads((BASE / "final-marketplace/harness/codex/tea-rags/.codex-plugin/plugin.json").read_text())["version"]


def setup(api, home, tag, source_inventory):
    assert not home.exists(), "Fresh home required"
    api.config(home, plugin_root=home / "plugins/cache/tea-rags")
    env = environment(api, home)
    logs = []
    for command in ([api.CODEX, "plugin", "marketplace", "add", str(BASE / "final-marketplace"), "--json"],
                    [api.CODEX, "plugin", "add", "tea-rags@tea-rags", "--json"]):
        result = subprocess.run(command, cwd=REPO, env=env, capture_output=True, text=True, timeout=120)
        logs.append({"command": command, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        dump(BASE / (tag + "-native-install.json"), logs)
        assert result.returncode == 0, result.stderr
    plugin = home / "plugins/cache/tea-rags/tea-rags" / plugin_version()
    verify_installed_plugin(plugin,source_inventory)
    transport = BASE / ("bin-" + tag)
    transport.mkdir()
    proxy_config = BASE / ("proxy-" + tag + ".json")
    cfg = json.loads((BASE / "upstream-template.json").read_text())
    cfg.update(forensic_dir=str(BASE / "private" / ("forensic-" + tag)),
        upstream_command=[api.NODE, str(BASE / "final-runtime/build/cli/index.js"), "server"],
        audit_log=str(BASE / ("proxy-" + tag + "-audit.jsonl")),
        upstream_stderr_log=str(BASE / ("proxy-" + tag + "-upstream-private-stderr.txt")))
    dump(proxy_config, cfg)
    shim = transport / "tea-rags"
    import shlex
    shim.write_text("#!/bin/sh\nexport BENCH_MCP_PROXY_CONFIG=" + shlex.quote(str(proxy_config)) + "\nexec " + shlex.quote(str(Path("/opt/homebrew/bin/python3").resolve())) + " " + shlex.quote(str(BASE / "lib/codex61_cli.py")) + ' "$@"\n')
    shim.chmod(0o755)
    extra = {"PATH": str(transport) + ":" + env["PATH"], "BENCH_MCP_PROXY_CONFIG": str(proxy_config)}
    rpc = api.RPC(home, BASE / ("hook-hashes-" + tag), extra_env=extra, allow_model_turns=False)
    try:
        listed = rpc.call("hooks/list", {"cwds": [REPO]})
        dump(BASE / (tag + "-hooks-before-trust.json"), listed)
    finally:
        rpc.close()
    hooks = [h for row in listed["data"] for h in row["hooks"]]
    assert len(hooks) == 14 and all(h.get("pluginId") == "tea-rags@tea-rags" for h in hooks)
    with (home / "config.toml").open("a") as out:
        for h in hooks:
            out.write("\n[hooks.state." + json.dumps(h["key"]) + "]\ntrusted_hash = " + json.dumps(h["currentHash"].split("/sha256:")[0]) + "\n")
    return extra, plugin


def proof(api, home, extra, plugin, production_home):
    out = BASE / "final-proof-A"
    rpc = api.RPC(home, out, extra_env=extra, allow_model_turns=False)
    try:
        thread = rpc.call("thread/start", {"cwd": REPO, "model": "gpt-6.1-sol", "permissions": "benchmark", "approvalPolicy": "never", "ephemeral": True, "experimentalRawEvents": True})
        dump(out / "thread-start.json", thread)
        assert thread["model"] == "gpt-6.1-sol" and thread.get("reasoningEffort") == "medium"
        assert thread["activePermissionProfile"]["id"] == "benchmark" and not thread.get("instructionSources")
        tid = thread["thread"]["id"]
        skills = rpc.call("skills/list", {"cwds": [REPO], "forceReload": True})
        hooks = rpc.call("hooks/list", {"threadId": tid, "cwds": []})
        plugins = rpc.call("plugin/list", {"cwds": [REPO], "forceRefetch": False, "marketplaceKinds": ["local"]})
        for name, value in (("skills", skills), ("hooks", hooks), ("plugins", plugins)):
            dump(out / (name + ".json"), value)
        enabled = [s for row in skills["data"] for s in row["skills"] if s.get("enabled")]
        flat_hooks = [h for row in hooks["data"] for h in row["hooks"]]
        assert len(enabled) == 18 and all(s.get("pluginId") == "tea-rags@tea-rags" for s in enabled)
        assert len(flat_hooks) == 14 and all(h["trustStatus"] == "trusted" and h.get("statusMessage", "").strip() for h in flat_hooks)
        deadline = time.monotonic() + 120
        while True:
            mcp = rpc.call("mcpServerStatus/list", {"threadId": tid, "limit": 100})
            if mcp["data"] and not any(s.get("runtimeStatus") == "starting" for s in mcp["data"]):
                break
            assert time.monotonic() < deadline
            try:
                rpc.pending.append(rpc.next(timeout=min(30, max(1, deadline - time.monotonic()))))
            except queue.Empty:
                pass
        dump(out / "mcp.json", mcp)
        assert len(mcp["data"]) == 1 and mcp["data"][0]["name"] == "tea-rags" and mcp["data"][0]["runtimeStatus"] == "connected", mcp
        protected = [str(BASE / "questions-only.json"), str(BASE / "lib/codex61_runner.py"), str(production_home / "auth.json"), str(home / "auth.json"),
                     "/Users/artk0re/.codex/auth.json", str(OLD / "runs/A/events.jsonl"), str(OLD / "questions-only.json"),
                     "/Users/artk0re/Dev/bench-private/taxdome/planning/questions.json", str(ROOT / "package.json"),
                     REPO + "/.git/HEAD"]
        # Existing source docs location plus controller/gold/old answer/auth paths are denied.
        docs = next((p for p in (Path(REPO) / "docs").rglob("*") if p.is_file()), None)
        if docs:
            protected.append(str(docs))
        code = "paths=" + repr(protected) + '\nfor p in paths:\n try:\n  f=open(p,"rb"); f.read(1); f.close(); print("ALLOWED")\n except OSError as e: print("DENIED",e.errno)'
        denied = rpc.call("command/exec", {"command": [str(Path("/opt/homebrew/bin/python3").resolve()), "-c", code], "cwd": REPO, "permissionProfile": "benchmark", "timeoutMs": 10000})
        dump(out / "filesystem-denials.json", denied)
        assert denied["stdout"].count("DENIED 1") == len(protected), denied
        dump(out / "protected-paths.json", protected)
        allowed_paths = [REPO + "/app/lib/tax_preparation/tax_automations/registry.rb", str(plugin / "skills/explore/SKILL.md")]
        allowed_code = "paths=" + repr(allowed_paths) + '\nfor p in paths:\n with open(p,"rb") as f: print("ALLOWED",len(f.read(1)))'
        allowed = rpc.call("command/exec", {"command": [str(Path("/opt/homebrew/bin/python3").resolve()), "-c", allowed_code], "cwd": REPO, "permissionProfile": "benchmark", "timeoutMs": 10000})
        dump(out / "filesystem-positive-source.json", allowed)
        assert allowed["exitCode"] == 0 and allowed["stdout"].count("ALLOWED 1") == len(allowed_paths), allowed
    finally:
        rpc.close()
    env = {**environment(api, home), **extra, "PLUGIN_ROOT": str(plugin)}
    outputs = {}
    for filename, event, args in [("session-start.sh", "SessionStart", []), ("session-codex-rules.sh", "SessionStart", []), ("turn-routing.sh", "UserPromptSubmit", ["--harness", "codex"])]:
        result = subprocess.run(["/bin/bash", str(plugin / "scripts" / filename), *args], cwd=REPO, env=env,
            input=json.dumps({"session_id": "clean-only-A-no-model", "cwd": REPO, "hook_event_name": event}), capture_output=True, text=True, timeout=30)
        (out / (filename + "-stdout.json")).write_text(result.stdout)
        assert result.returncode == 0 and result.stdout.strip(), filename
        outputs[filename] = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    core, rules = outputs["session-start.sh"], outputs["session-codex-rules.sh"]
    assert len(rules) <= 9500 and rules == (plugin / "scripts/codex-rules.txt").read_text().rstrip("\n")
    assert "matching native `wait` / `write_stdin`" in rules
    summary = {"ready": True, "model_turns": 0, "enabled_skills": len(enabled), "trusted_labeled_hooks": len(flat_hooks), "mcp_servers": 1,
               "mcp_runtime_status": "connected", "source_instruction_sources": thread.get("instructionSources"),
               "codex_rules_chars": len(rules), "codex_rules_sha256": hashlib.sha256(rules.encode()).hexdigest(),
               "actual_core_new_batch_gate": "content inspected separately by focused behavioral evals", "candidate_response_contract_present": False,
               "protected_paths_denied": len(protected), "existing_docs_file": str(docs) if docs else None,
               "docs_boundary": "Same native profile denies docs/, specs/, and every Markdown extension; no existing docs file was available for a positive read-denial probe" if not docs else "Existing docs file read denied",
               "model": thread["model"], "effort": thread["reasoningEffort"], "context_window_override": None}
    dump(BASE / "final-proof-summary.json", summary)
    assert not (production_home / "sessions").exists(), "Production home must have zero prior sessions"
    return summary



def capture_source_inputs():
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    tracked=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    roots=('src/','scripts/','plugins/','harness/','.agents/plugins/')
    selected=sorted(set(n for n in tracked if n and (n.startswith(roots) or
        ('/' not in n and (n.endswith('.json') or n=='.qdrant-required-version')))))
    paths=[n for n in selected if (ROOT/n).is_file() or (ROOT/n).is_symlink()]
    return {'head':head,'paths':paths,
            'files':{n:sha(ROOT/n) for n in paths if not (ROOT/n).is_symlink()},
            'symlinks':{n:str((ROOT/n).readlink()) for n in paths if (ROOT/n).is_symlink()}}


def freeze_source_inputs(runtime):
    runtime.mkdir()
    before=capture_source_inputs()
    for name in before['files']:
        target=runtime/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(ROOT/name,target)
    after=capture_source_inputs()
    assert before==after, 'Source HEAD, input path inventory or bytes changed during freeze; no actors started'
    assert {n:sha(runtime/n) for n in before['files']}==before['files'], 'Copied snapshot differs from initial source hashes'
    dump(BASE/'frozen-source-inputs.json',before['files'])
    dump(BASE/'source-capture.json',before)
    return before


def freeze_and_build(runtime):
    captured=freeze_source_inputs(runtime)
    (runtime/'node_modules').symlink_to(ROOT/'node_modules')
    env=os.environ.copy()
    env["PATH"]="/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin:"+env.get("PATH","")
    with (BASE/"snapshot-build.log").open("w") as log:
        for cmd in (["npm","run","-s","gen:plugins"],["npm","run","build"]):
            result=subprocess.run(cmd,cwd=runtime,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
            assert result.returncode==0,"Snapshot generation/build failed; see snapshot-build.log"
    dump(BASE/"snapshot-build-proof.json",{"ready":True,"source_inputs":len(captured["files"]),"source_HEAD_at_capture":captured["head"],"source_capture_sha256":sha(BASE/"source-capture.json"),"inputs_sha256":sha(BASE/"frozen-source-inputs.json"),"build_log_sha256":sha(BASE/"snapshot-build.log"),"model_turns":0,"node_modules":"shared symlink; lockfile frozen; dependencies not copied"})



def stage(name, action, outputs):
    """No-model stages may resume; partial evidence is archived, never overwritten."""
    assert not (BASE/"runs").exists() and not (BASE/"ROOTGO.json").exists(), "No preparation after actor launch"
    marker=BASE/'stages'/(name+'.json')
    if marker.exists():
        record=json.loads(marker.read_text())
        for path,expected in record['files'].items():
            assert sha(path)==expected, 'Prepared stage changed: '+path
        return
    # Aborted no-model stages retain all artifacts for review. Actor paths are never moved.
    existing=[p for p in outputs if p.exists() or p.is_symlink()]
    if existing:
        archive=BASE/'abandoned-no-model'/(name+'-'+str(time.time_ns()));archive.mkdir(parents=True)
        for i,p in enumerate(existing):shutil.move(str(p),str(archive/(str(i)+'-'+p.name)))
        dump(archive/'reason.json',{'stage':name,'reason':'Explicit --resume-no-model; preserve incomplete no-model stage','model_turns':0})
    action()
    files={str(p):sha(p) for output in outputs for p in ([output] if output.is_file() else output.rglob('*'))
           if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and not p.name.endswith('.jsonl')
           and not p.name.endswith('stderr.txt')
           and (not any(part in {'homes','proof-homes'} for part in p.relative_to(BASE).parts)
                or p.name=='config.toml' or 'plugins/cache/' in str(p.relative_to(BASE)))}
    dump(marker,{'model_turns':0,'files':files})


def existing_backend(api,home,tag):
    return {'PATH':str(BASE/('bin-'+tag))+':'+environment(api,home)['PATH'],
            'BENCH_MCP_PROXY_CONFIG':str(BASE/('proxy-'+tag+'.json'))}


def main():
    global ROOT,BASE,BASELINE,OLD,SOURCE_COMMIT,CORPUS_COMMIT
    import argparse
    parser=argparse.ArgumentParser(description='Fresh A-only preparation; no B configuration and never sends turn/start')
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--base',type=Path,required=True)
    parser.add_argument('--baseline',type=Path,required=True,help='Read-only previous frozen harness; no old answers are copied')
    parser.add_argument('--resume-no-model',action='store_true')
    args=parser.parse_args();controller_python=require_controller_python();ROOT=args.source.resolve();BASE=args.base.resolve();BASELINE=args.baseline.resolve()
    assert BASE!=BASELINE and BASELINE not in BASE.parents and BASE not in BASELINE.parents
    assert BASE!=HELPERS and HELPERS not in BASE.parents, 'Helpers and run evidence must be separate'
    assert BASE.exists()==args.resume_no_model, 'Fresh base or explicit --resume-no-model required'
    assert not (BASE/'runs').exists() and not (BASE/'ROOTGO.json').exists(), 'Never resume or alter any actor'
    SOURCE_COMMIT=(json.loads((BASE/'source-capture.json').read_text())['head']
                   if args.resume_no_model and (BASE/'source-capture.json').exists()
                   else subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip())
    CORPUS_COMMIT=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    assert not subprocess.check_output(['git','status','--porcelain'],cwd=REPO,text=True).strip()
    assert CORPUS_COMMIT==json.loads((BASELINE/'final-manifest.json').read_text())['corpus_commit'], 'Historical corpus changed; review required'
    OLD=BASELINE
    identity={'source':str(ROOT),'source_commit':SOURCE_COMMIT,'baseline':str(BASELINE),'corpus_commit':CORPUS_COMMIT,
              'model':'gpt-6.1-sol','effort':'medium','order':['A'],'runs_per_condition':1,'controller_python':controller_python}
    if not args.resume_no_model:
        BASE.mkdir(mode=0o700,parents=True);(BASE/'stages').mkdir();dump(BASE/'preparation-identity.json',identity)
    else:assert json.loads((BASE/'preparation-identity.json').read_text())==identity, 'Inputs changed; use a fresh base'
    runtime_record = BASE / 'controller-python.json'
    if args.resume_no_model:
        verify_runtime(json.loads(runtime_record.read_text()))
    else:
        dump(runtime_record, controller_python)
    stage('libraries',copy_modules,[BASE/'lib',BASE/'original-module-hashes.json',BASE/'upstream-template.json'])
    sys.path.insert(0,str(BASE/'lib'));api=importlib.import_module('codex61_app_rpc');runner=importlib.import_module('codex61_runner');runner.configure(BASE)
    # Verify exact CLI version and preserve machine-generated native request semantics.
    cli_version=verify_native_cli(api)
    questions=BASELINE/'questions-only.json'
    qs=json.loads(questions.read_text());assert len(qs)==39 and all(set(q)=={'id','question'} for q in qs)
    assert [q['id'] for q in qs]==['Q%02d'%i for i in range(1,40)]
    stage('questions',lambda:shutil.copy2(questions,BASE/'questions-only.json'),[BASE/'questions-only.json'])
    runtime=BASE/'final-runtime'
    stage('snapshot-build',lambda:freeze_and_build(runtime),[runtime,BASE/'frozen-source-inputs.json',BASE/'source-capture.json',BASE/'snapshot-build.log',BASE/'snapshot-build-proof.json'])
    # The captured snapshot is authoritative; later source commits cannot alter it.
    captured=json.loads((BASE/'source-capture.json').read_text())
    SOURCE_COMMIT=captured['head'];identity['source_commit']=SOURCE_COMMIT
    dump(BASE/'preparation-identity.json',identity)
    marketplace=BASE/'final-marketplace'
    def marketplace_stage():
        shutil.copytree(runtime/'harness/codex/tea-rags',marketplace/'harness/codex/tea-rags')
        catalog=json.loads((runtime/'.agents/plugins/marketplace.json').read_text())
        catalog['plugins']=[p for p in catalog['plugins'] if p['name']=='tea-rags']
        (marketplace/'.agents/plugins').mkdir(parents=True);dump(marketplace/'.agents/plugins/marketplace.json',catalog)
    stage('marketplace',marketplace_stage,[marketplace])
    expected=inventory(marketplace/'harness/codex/tea-rags');assert expected==inventory(runtime/'harness/codex/tea-rags')
    backends={};proof_backends={}
    for cell in ['A']:
        production=BASE/'homes'/cell;proof_home=BASE/'proof-homes'/cell
        for home,tag in [(production,'run-A'),(proof_home,'proof-A')]:
            outputs=[home,BASE/('bin-'+tag),BASE/('proxy-'+tag+'.json'),BASE/('hook-hashes-'+tag),BASE/(tag+'-native-install.json'),BASE/(tag+'-hooks-before-trust.json')]
            stage('install-'+tag,lambda home=home,tag=tag:setup(api,home,tag,expected),outputs)
        backends['A']=existing_backend(api,production,'run-A');proof_backends['A']=existing_backend(api,proof_home,'proof-A')
        actual=verify_installed_plugin(production/'plugins/cache/tea-rags/tea-rags'/plugin_version(),expected)
        proof_actual=verify_installed_plugin(proof_home/'plugins/cache/tea-rags/tea-rags'/plugin_version(),expected)
        counts={'frozen_generated_source':len(expected),'production_A':len(actual),'proof_A':len(proof_actual),
                'installed_total_across_production_and_proof_A':len(actual)+len(proof_actual),
                'meaning':'Counts are descriptive; exact per-home path/hash equality is the gate'}
        dump(BASE/'actual-installed-A-plugin.json',actual)
        dump(BASE/'actual-installed-proof-A-plugin.json',proof_actual)
        dump(BASE/'plugin-inventory-counts.json',counts)
        stage('proof-A',lambda:proof(api,proof_home,proof_backends['A'],proof_home/'plugins/cache/tea-rags/tea-rags'/plugin_version(),production),[BASE/'final-proof-A',BASE/'final-proof-summary.json'])
        assert not (production/'sessions').exists(),'Production home must remain pristine'
        assert 'memories = false' in (production/'config.toml').read_text()
    # Persist native capability catalog without injecting benchmark history or sending a model prompt.
    def catalog_stage():
        result=subprocess.run([api.CODEX,'debug','prompt-input'],cwd=REPO,env={**environment(api,BASE/'proof-homes/A'),**proof_backends['A']},capture_output=True,text=True,timeout=120)
        assert result.returncode==0,result.stderr;(BASE/'model-tool-catalog.json').write_text(result.stdout)
    stage('tool-catalog',catalog_stage,[BASE/'model-tool-catalog.json'])
    def flatten(items,prefix=''):
        result={}
        for item in items:
            name=prefix+item.get('name','')
            if item.get('type')=='namespace':result.update(flatten(item.get('tools',[]),name+'.'))
            else:result[name]=item.get('description','')
        return result
    toolset={}
    for item in json.loads((BASE/'model-tool-catalog.json').read_text()):
        if item.get('type')=='additional_tools':toolset.update(flatten(item.get('tools',[])))
    assert 'clock.sleep' not in toolset
    assert 'functions.wait' in toolset and 'functions.request_user_input_async' in toolset
    assert 'write_stdin' in toolset['functions.exec']
    dump(BASE/'tool-exposure-proof.json',{'model_turns':0,'sleep_absent':True,'native_wait_present':True,
        'write_stdin_present':True,'async_question_present':True,'tool_names':sorted(toolset),
        'profile_policy':'Unmodified frozen native profile builder; questions remain enabled'})
    corpus=runner.corpus_inventory();dump(BASE/'corpus-readable-inventory.json',corpus)
    frozen=[p for directory in [BASE/'lib',runtime/'build',runtime/'plugins',marketplace] for p in directory.rglob('*') if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts]
    for cell in ['A']:frozen += [BASE/'homes'/cell/'config.toml',BASE/'proof-homes'/cell/'config.toml']
    frozen += [BASE/'controller-python.json',Path(controller_python['executable']),BASE/'questions-only.json',BASE/'corpus-readable-inventory.json',BASE/'actual-installed-A-plugin.json',BASE/'actual-installed-proof-A-plugin.json',BASE/'plugin-inventory-counts.json',BASE/'original-module-hashes.json',BASE/'frozen-source-inputs.json',BASE/'source-capture.json',BASE/'snapshot-build-proof.json',BASE/'model-tool-catalog.json',BASE/'tool-exposure-proof.json',Path(api.CODEX),Path(api.NODE),Path(api.RG)]
    frozen += [runtime/name for name in ['package.json','package-lock.json','.qdrant-required-version']]
    for installed_home in [BASE/'homes/A',BASE/'proof-homes/A']:
        frozen += [p for p in (installed_home/'plugins/cache/tea-rags/tea-rags'/plugin_version()).rglob('*') if p.is_file()]
    frozen += [BASE/'proxy-run-A.json',BASE/'proxy-proof-A.json',BASE/'bin-run-A/tea-rags',BASE/'bin-proof-A/tea-rags']
    frozen += [HELPERS/name for name in ['prepare.py','protocol.py','runner.py','run.py','collect.py','job.py','controller_io.py','mcp_readiness.py','transport_probe.py','schema/ToolRequestUserInputParams.json','native-schema-provenance.json']]
    manifest={**identity,'ROOTGO':False,'prepared_model_turns':0,'preflight_ready':True,'runs_authorized':['A'],
              'independent_security_review':'pending','focused_cases':'pending','transport_preservation':'pending',
              'backend_env':backends,'proof_backend_env':proof_backends,'plugin_version':plugin_version(),
              'real_tool_names':sorted(json.loads((BASE/'final-proof-A/mcp.json').read_text())['data'][0]['tools']),
              'source_plugin_sha256':expected,'actual_installed_A_plugin_sha256':actual,'actual_installed_proof_A_plugin_sha256':proof_actual,'plugin_inventory_counts':counts,
              'codex_cli_version':cli_version,'corpus_commit':CORPUS_COMMIT,'frozen_files':{str(p):sha(p) for p in frozen},
              'cache_policy':'Prefix cache cannot be manually cleared; fresh homes do not imply zero cached tokens on all turns',
              'question_protocol':'isBlocking:false recorded; keep native event wait until turn/completed. isBlocking:true awaiting_user, no fabricated answer, interrupt only for cleanup. Missing flag aborts protocol.',
              'context':'Fresh independent homes/threads; same opening+39 questions, no resume/fork/gold/old answers; memory feature false in A; natural within-condition context',
              'limitations':['n=1 A-only; shared live index/service/provider cache/load confounds','node_modules symlink and live index/services not byte-frozen','Raw response incompletion makes total cost unknown'],
              'source_worktree_status':subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).splitlines()}
    dump(BASE/'final-manifest.json',manifest)
    seconds=runner.verify_frozen(manifest)
    dump(BASE/'A-prelaunch-verification.json',{'ready':True,'seconds':seconds,'model_turns':0})
    print('PREPARED_NO_MODEL',BASE,'root launch requires focused cases + independent review + transport preservation PASS',flush=True)

if __name__=='__main__':main()
