"""Minimal local app-server JSON-RPC client. No model calls unless explicitly requested."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

NODE='/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin/node'
CODEX='/Users/artk0re/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
RG='/Users/artk0re/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path/rg'
REPO='/Users/Shared/nav-ab/repo-master'
PROCESS_PROFILE=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/codex61/process-boundary.sb')

def launch_prefix():
    # macOS prohibits nested sandbox_apply. Native managed FS/network profile
    # is the actual boundary. Benchmark process metadata is sanitized instead.
    return []

class RPC:
    def __init__(self,home,logdir,extra_env=None,allow_model_turns=False):
        self.allow_model_turns=allow_model_turns; self.user_requests=[]
        self.home=Path(home).resolve(); self.logdir=Path(logdir).resolve()
        self.logdir.mkdir(exist_ok=True,parents=True)
        self.proc=None; self.reader=None; self.raw=None; self.err=None; self.closed=False
        try:
            self.raw=(self.logdir/'events.jsonl').open('w')
            self.err=(self.logdir/'stderr.txt').open('w')
            # No inherited application credentials. Auth remains an orchestrator-only file.
            env={'PATH':str(Path(NODE).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                 'HOME':'/Users/artk0re','CODEX_HOME':str(self.home),'ASDF_NODEJS_VERSION':'24.15.0','LANG':'en_US.UTF-8'}
            env.update(extra_env or {})
            self.proc=subprocess.Popen(launch_prefix()+[CODEX,'app-server','--stdio','--strict-config'],cwd=REPO,env=env,
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.err,text=True,bufsize=1,start_new_session=True)
            self.q=queue.Queue(); self.id=0; self.pending=[]; self.lock=threading.Lock()
            def reader():
                for line in self.proc.stdout:
                    with self.lock: self.raw.write(line); self.raw.flush()
                    try: self.q.put(json.loads(line))
                    except json.JSONDecodeError: pass
                self.q.put({'_process_exit':self.proc.poll()})
            self.reader=threading.Thread(target=reader,daemon=True);self.reader.start()
            self.call('initialize',{'clientInfo':{'name':'gruntworx-planning-benchmark','version':'1.0'},
                'capabilities':{'experimentalApi':True}},timeout=120)
            self.notify('initialized',{})
        except BaseException:
            try:self.close()
            except BaseException:pass
            raise

    def send(self,message):
        if message.get("method") in {"turn/start","turn/steer","thread/resume"} and not self.allow_model_turns:
            raise RuntimeError("Model requests disabled: explicit ROOTGO required")
        self.proc.stdin.write(json.dumps(message,ensure_ascii=False)+'\n'); self.proc.stdin.flush()

    def notify(self,method,params): self.send({'method':method,'params':params})

    def next(self,timeout=180):
        e=self.q.get(timeout=timeout)
        if '_process_exit' in e: raise RuntimeError('app-server exited '+str(e))
        # Fail closed on all backend/model approval requests.
        if e.get('method') == 'item/tool/requestUserInput' and 'id' in e:
            self.user_requests.append(e)
        elif 'method' in e and 'id' in e:
            self.send({'id':e['id'],'error':{'code':-32000,'message':'Benchmark approvals are disabled'}})
        return e

    def call(self,method,params,timeout=180):
        self.id+=1; rid=self.id
        self.send({'method':method,'id':rid,'params':params})
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            e=self.next(timeout=max(1,deadline-time.monotonic()))
            if e.get('id')==rid and 'method' not in e:
                if 'error' in e: raise RuntimeError(method+': '+json.dumps(e['error']))
                return e['result']
            self.pending.append(e)
        raise TimeoutError(method)

    def close(self):
        if self.closed:return
        self.closed=True
        try:
            if self.proc is not None:
                self.proc.terminate()
                try:self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
                if self.reader is not None:self.reader.join(timeout=10)
        finally:
            for handle in [getattr(self.proc,'stdin',None),getattr(self.proc,'stdout',None),self.raw,self.err]:
                if handle is not None and hasattr(handle,'close'):
                    try:handle.close()
                    except OSError:pass

def config(home,plugin_root=None,extra_roots=()):
    home=Path(home).resolve();home.mkdir(parents=True,exist_ok=True)
    auth=home/'auth.json'
    if not auth.exists():auth.symlink_to('/Users/artk0re/.codex/auth.json')
    rg=Path(RG)
    py=Path('/opt/homebrew/bin/python3')
    py_framework=next(p for p in py.resolve().parents if p.name=='Python.framework')
    roots=[REPO,CODEX,NODE,str(rg),str(rg.resolve()),str(py),str(py_framework),
        '/opt/homebrew/opt/pcre2',str(Path('/opt/homebrew/opt/pcre2').resolve()),*map(str,extra_roots)]
    if plugin_root:roots.append(str(Path(plugin_root).resolve()))
    text='''model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
approval_policy = "never"
default_permissions = "benchmark"
allow_login_shell = false
web_search = "disabled"
project_doc_max_bytes = 0

[features]
sleep_tool = false
default_mode_request_user_input = true
apps = false
browser_use = false
browser_use_external = false
in_app_browser = false
computer_use = false
image_generation = false
view_image = false
multi_agent = false
memories = false
shell_snapshot = false
skip_host_skill_discovery = true
remote_plugin = false
plugin_sharing = false
plugin_discovery_prefetch = false
skill_search = false
skill_mcp_dependency_install = false
plugins = PLUGINS
hooks = PLUGINS

[projects."/Users/Shared/nav-ab/repo-master"]
trust_level = "trusted"

[shell_environment_policy]
inherit = "none"
set = { PATH = "/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME = "/nonexistent", TMPDIR = "/nonexistent", LANG = "en_US.UTF-8", ASDF_NODEJS_VERSION = "24.15.0" }

[permissions.benchmark.filesystem]
":root" = "deny"
":minimal" = "read"
":slash_tmp" = "deny"
":tmpdir" = "deny"
'''.replace('PLUGINS','true' if plugin_root else 'false')
    direct_path=':'.join([str(py.resolve().parent),str(rg.resolve().parent),str(Path(NODE).parent),'/usr/bin','/bin','/usr/sbin','/sbin'])
    text=text.replace('/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',direct_path)
    text+=''.join(json.dumps(x)+' = "read"\n' for x in dict.fromkeys(roots))
    text+='''
[permissions.benchmark.filesystem."/Users/Shared/nav-ab/repo-master"]
".git" = "deny"
".agents" = "deny"
".codex" = "deny"
".claude" = "deny"
".contextignore.local" = "deny"
"docs" = "deny"
"specs" = "deny"
"**/*.md" = "deny"
"**/*.MD" = "deny"
"**/*.markdown" = "deny"
"**/*.MARKDOWN" = "deny"
"**/*.mdx" = "deny"
"**/*.MDX" = "deny"

[permissions.benchmark.network]
enabled = false
'''
    for name in ['imagegen','openai-docs','review-agent','skill-creator','skill-installer']:
        text+='\n[[skills.config]]\npath = '+json.dumps(str(home/'skills/.system'/name/'SKILL.md'))+'\nenabled = false\n'
    # TOML cannot define same path as a direct scalar and then as a subtable.
    text=text.replace(json.dumps(REPO)+' = "read"\n','')
    text=text.replace('[permissions.benchmark.filesystem."'+REPO+'"]',
        '[permissions.benchmark.filesystem."'+REPO+'"]\n"." = "read"')
    (home/'config.toml').write_text(text)
    return text
