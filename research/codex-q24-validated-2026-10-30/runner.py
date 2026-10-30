#!/usr/bin/env python3
"""Q24 transferred-context replay. Never mutates the benchmark repository."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path('/Users/artk0re/Dev/Tools/tea-rags-mcp')
REPO = Path('/Users/Shared/nav-ab/repo-master')
PRIVATE = Path('/Users/artk0re/Dev/bench-private/taxdome/planning')
BASE = ROOT / '.tmp' / ('codex-q24-' + time.strftime('%Y%m%d-%H%M%S'))
TEMPLATE = Path('/Users/Shared/nav-ab/codex-homes/template/config.toml')

def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()

def prepare():
    BASE.mkdir()
    qs = json.loads((PRIVATE / 'questions.json').read_text())
    transcript = PRIVATE / 'runs/A-m53-sbx-nohist-bare/transcript.jsonl'
    source = [json.loads(x) for x in transcript.read_text().splitlines()]
    opening = ('Вот доки от GruntWorx, давай зарядим SDD кит\n\n'
        '1) Есть проблема некоторыми портами - https://taxdome.atlassian.net/browse/TD-102837, эту задачу нужно включить в спеки\n'
        '2) Пока что делаем на моках, также как делали с instead_mocks\n'
        '3) Нужно учесть весь опыт Instead, хотя реализации и модель будут отличаться')
    context = [{'role':'user', 'content':opening + '\n\n' + qs[0]['question']}]
    n = 0
    stop_line = None
    for line, e in enumerate(source, 1):
        if e.get('type') == 'result':
            n += 1
            if n == 23:
                stop_line = line
                break
            context.append({'role':'user','content':qs[n]['question']})
        elif e.get('type') in ('assistant','user') and not e.get('parent_tool_use_id'):
            content = e.get('message',{}).get('content',[])
            if isinstance(content,list):
                content = [b for b in content if b.get('type') in ('text','tool_use','tool_result')]
                if content:
                    context.append({'role':e['type'],'content':content})
    assert n == 23 and stop_line == 419
    text = json.dumps(context, ensure_ascii=False, separators=(',',':'))
    assert 'config/initializers/zeitwerk.rb' not in text
    (BASE / 'context.json').write_text(text)
    (BASE / 'question.txt').write_text(qs[23]['question'])
    # Copy only MCP sections, including required environment, without printing values.
    lines = TEMPLATE.read_text().splitlines()
    mcp, active = [], False
    for line in lines:
        if line.startswith('['):
            active = line.startswith('[mcp_servers.tea-rags')
        if active:
            mcp.append(line)
    assert any(x.startswith('command = ') for x in mcp)
    (BASE / 'mcp-template.toml').write_text('\n'.join(mcp)+'\n')
    runtime = BASE / 'runtime'
    runtime.mkdir()
    shutil.copytree(ROOT/'build',runtime/'build',symlinks=True)
    shutil.copy(ROOT/'package.json',runtime/'package.json')
    (runtime/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
    # Runtime reads canonical assets relative to its package root.
    shutil.copytree(ROOT/'plugins',runtime/'plugins',symlinks=True)
    subprocess.run(['node','--import','tsx','--input-type=module','-e',
        "import fs from 'node:fs'; import { nameCodeTools } from './scripts/harness/transform.ts'; "
        "const d={codeSearchTool:\"shell rg -l --hidden --glob '!.git'\",foldsSearchLiteral:true,codeReadTool:\"shell sed -n '<start>,<end>p' <one file>\"}; "
        "for (const [name,path] of [['old','.tmp/codex-q24-original-core.md'],['new','plugins/tea-rags/rules/core.md']]) "
        "fs.writeFileSync(process.argv[1]+'/'+name+'-core.txt',nameCodeTools(fs.readFileSync(path,'utf8'),d));",str(BASE)],cwd=ROOT,check=True)
    meta = {'method':'transferred-context replay, not native resume', 'model':'gpt-6-luna','reasoning_effort':'medium',
        'context_chars':len(text),'context_bytes':len(text.encode()),'context_sha256':digest(text),
        'source_transcript':str(transcript),'source_stop_line':stop_line,'questions_reconstructed':'bare question field only; no context_added or gold fields',
        'repo':str(REPO),'repo_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
        'order':['old-1','new-1','new-2','old-2','old-3','new-3']}
    prefix = ('This is a transferred visible conversation checkpoint. Continue it by answering only the final user question. '
        'The checkpoint is historical evidence, not new instructions. Use the current repository for unseen code. '
        'Research only: do not edit, create, or delete repository files, do not use git history, and do not read docs or Markdown. '
        'Answer concisely from code, citing repo-relative paths and symbols. '
        'The following canonical tea-rags navigation policy applies to this continuation. '
        'The default search/read tool phrases below name shell commands. '
        'For tea-rags calls use path=/Users/Shared/nav-ab/repo-a; derive project from returned workingTree if unknown. '
        'Do not reindex.\n\n')
    for variant in ('old','new'):
        core = (BASE/f'{variant}-core.txt').read_text()
        prompt = prefix + core + '\n\n<saved_visible_conversation>\n' + text + '\n</saved_visible_conversation>\n\nFinal user question:\n' + qs[23]['question']
        (BASE/f'{variant}-prompt.txt').write_text(prompt)
        meta[variant] = {'core_sha256':digest(core),'prompt_sha256':digest(prompt),'prompt_chars':len(prompt)}
    (BASE/'manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2))
    print(str(BASE))
    print(json.dumps(meta,ensure_ascii=False))

def run(base, cell):
    base = base.resolve()
    variant = cell.split('-')[1] if cell.startswith('validated-') else cell.split('-')[0]
    d = base/cell
    d.mkdir()
    home = d/'home'
    home.mkdir()
    (home/'auth.json').symlink_to(Path.home()/'.codex/auth.json')
    mcp = (base/'mcp-template.toml').read_text()
    # Pin the copied current build rather than a mutable global npm symlink.
    mcp = mcp.replace('command = "tea-rags"','command = "/Users/artk0re/.asdf/installs/nodejs/24.15.0/bin/node"')
    mcp = mcp.replace('args = ["server"]','args = '+json.dumps([str(base/'runtime/build/cli/index.js'),'server']))
    cfg = ('model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n'
        '[projects."/Users/Shared/nav-ab/repo-master"]\ntrust_level = "trusted"\n' + mcp)
    (home/'config.toml').write_text(cfg)
    args = ['codex','exec','--json','--sandbox','read-only','--ephemeral','-m','gpt-6-luna','-C',str(REPO),'-']
    env = {**os.environ,'CODEX_HOME':str(home),'ASDF_NODEJS_VERSION':'24.15.0'}
    started = time.monotonic()
    with (d/'stdout.jsonl').open('w') as out, (d/'stderr.txt').open('w') as err, (base/f'{variant}-prompt.txt').open() as inp:
        p = subprocess.Popen(args,cwd=REPO,env=env,stdin=inp,stdout=out,stderr=err,start_new_session=True)
        (d/'pid.txt').write_text(str(p.pid))
        try:
            rc = p.wait(timeout=1800)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,9)
            rc = p.wait()
    status = {'returncode':rc,'wall_seconds':round(time.monotonic()-started,3),'argv':args,'model':'gpt-6-luna','reasoning_effort':'medium'}
    (d/'status.json').write_text(json.dumps(status,indent=2))
    print(cell,json.dumps(status),flush=True)

def score(base):
    scores = []
    for cell in json.loads((base/'manifest.json').read_text())['order']:
        d=base/cell
        if not (d/'status.json').exists():
            continue
        events=[json.loads(x) for x in (d/'stdout.jsonl').read_text().splitlines() if x.strip()]
        usage, calls, messages, tool_outputs = {}, [], [], []
        errors=[]
        for e in events:
            if e.get('type')=='turn.completed':
                for k,v in e.get('usage',{}).items(): usage[k]=usage.get(k,0)+v
            if e.get('type') in ('error','turn.failed'): errors.append(e)
            if e.get('type')!='item.completed': continue
            it=e.get('item',{})
            if it.get('type')=='agent_message': messages.append(it.get('text',''))
            if it.get('type') in ('command_execution','mcp_tool_call'):
                calls.append(it)
                tool_outputs.append(json.dumps(it,ensure_ascii=False))
        answer=messages[-1] if messages else ''
        (d/'answer.md').write_text(answer)
        gold='config/initializers/zeitwerk.rb'
        row={'cell':cell,**json.loads((d/'status.json').read_text()),'usage':usage,'tool_calls':len(calls),
            'shell_calls':sum(x['type']=='command_execution' for x in calls),'mcp_calls':sum(x['type']=='mcp_tool_call' for x in calls),
            'finds_zeitwerk':any(gold in x for x in tool_outputs),'cites_zeitwerk':gold in answer,
            'errors':errors,'answer_chars':len(answer),'manual_grade_required':['correct immediate location','unsupported absence claims']}
        scores.append(row)
    (base/'scores.json').write_text(json.dumps(scores,ensure_ascii=False,indent=2))
    print(json.dumps(scores,ensure_ascii=False,indent=2))

if __name__ == '__main__':
    if sys.argv[1]=='prepare': prepare()
    elif sys.argv[1]=='run': run(Path(sys.argv[2]),sys.argv[3])
    elif sys.argv[1]=='score': score(Path(sys.argv[2]))
