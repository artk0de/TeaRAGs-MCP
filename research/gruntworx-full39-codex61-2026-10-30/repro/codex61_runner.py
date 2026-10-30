#!/usr/bin/env python3
"""Fresh Q01..Q39 Codex A/B. Preparation and execution are explicitly separate.

No saved conversation is loaded. Gold is never read by the execution routine.
Models cannot read controller files, homes, logs, benchmark source or sibling cells.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import time
from codex61_app_rpc import RPC,config,CODEX,NODE,REPO

ROOT=Path('/Users/artk0re/Dev/Tools/tea-rags-mcp')
BASE=ROOT/'.tmp/codex61'
OPENING='''Вот доки от GruntWorx, давай зарядим SDD кит

1) Есть проблема некоторыми портами - https://taxdome.atlassian.net/browse/TD-102837, эту задачу нужно включить в спеки
2) Пока что делаем на моках, также как делали с instead_mocks
3) Нужно учесть весь опыт Instead, хотя реализации и модель будут отличаться'''
QUESTIONS=Path('/Users/artk0re/Dev/bench-private/taxdome/planning/questions.json')

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def inventory(root):
    return {str(p.relative_to(root)):sha(p) for p in sorted(Path(root).rglob('*')) if p.is_file() and not p.is_symlink()}

def corpus_inventory():
    source=Path(REPO);result={}
    for base,dirs,files in os.walk(source,followlinks=False):
        dirs[:]=[d for d in dirs if d not in {'.git','.agents','.codex','.claude','docs','specs'}]
        for name in files:
            p=Path(base)/name
            if name in {'.git','.contextignore.local'} or name.lower().endswith(('.md','.markdown','.mdx')):continue
            rel=str(p.relative_to(source))
            result[rel]={'link':str(p.readlink())} if p.is_symlink() else {'bytes':p.stat().st_size,'sha256':sha(p)}
    return result

def prepare_questions():
    # This is the only pre-run reader of questions.json; project only text/id.
    raw=json.loads(QUESTIONS.read_text())
    qs=[{'id':q['id'],'question':q['question']} for q in raw]
    assert len(qs)==39 and [q['id'] for q in qs]==['Q%02d'%i for i in range(1,40)]
    BASE.mkdir(exist_ok=True)
    (BASE/'questions-only.json').write_text(json.dumps(qs,ensure_ascii=False,indent=2))
    print('prepared39 questions-only; hash',sha(BASE/'questions-only.json'))

def verify_frozen(manifest):
    check_started=time.monotonic()
    for name,expected in manifest['frozen_files'].items():
        assert sha(name)==expected,'Frozen artifact changed: '+name
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()==manifest['corpus_commit']
    assert not subprocess.check_output(['git','status','--porcelain'],cwd=REPO,text=True).strip(),'Corpus became dirty'
    expected=json.loads((BASE/'corpus-readable-inventory.json').read_text())
    actual=corpus_inventory()
    assert actual==expected,'Actual readable corpus changed (including ignored eligible files)'
    return time.monotonic()-check_started

def execute(cell):
    assert cell in ['A','B']
    manifest=json.loads((BASE/'final-manifest.json').read_text())
    assert manifest.get('ROOTGO') is True, 'No actor request before ROOTGO'
    assert manifest.get('parent_final_build_signal') and manifest.get('independent_security_review')=='ready'
    pre_launch_verification=verify_frozen(manifest)
    out=BASE/'runs'/cell
    assert not out.exists(),'Never silently overwrite or repeat a full cell'
    out.mkdir(parents=True)
    home=BASE/'homes'/cell
    assert home.exists() and not (home/'sessions').exists(),'Production home must have no prior sessions'
    # Read sanitized questions only; execution never opens gold-bearing source.
    qs=json.loads((BASE/'questions-only.json').read_text())
    rpc=RPC(home,out,extra_env=manifest['backend_env'].get(cell,{}),allow_model_turns=True)
    started=time.monotonic(); marks=[];verification_seconds=0
    try:
        thread=rpc.call('thread/start',{'cwd':REPO,'model':'gpt-6.1-sol','permissions':'benchmark',
            'approvalPolicy':'never','ephemeral':False,'experimentalRawEvents':True})
        assert thread['model']=='gpt-6.1-sol' and thread['activePermissionProfile']['id']=='benchmark'
        assert thread.get('reasoningEffort')=='medium'
        assert not thread.get('instructionSources'), 'Unexpected host/project instructions'
        tid=thread['thread']['id']
        (out/'thread-start.json').write_text(json.dumps(thread,ensure_ascii=False,indent=2))
        for i,q in enumerate(qs):
            check_seconds=verify_frozen(manifest);verification_seconds+=check_seconds
            text=q['question'] if i else OPENING+'\n\n'+q['question']
            sent=time.monotonic(); mark={'id':q['id'],'sent_at':round(sent-started,3),'pre_turn_verification_seconds':round(check_seconds,3),'prompt_sha256':hashlib.sha256(text.encode()).hexdigest()}
            turn=rpc.call('turn/start',{'threadId':tid,'cwd':REPO,'permissions':'benchmark','approvalPolicy':'never',
                'model':'gpt-6.1-sol','effort':'medium','input':[{'type':'text','text':text}]})
            turn_id=turn['turn']['id'];mark['turn_id']=turn_id
            events=rpc.pending;rpc.pending=[]
            deadline=time.monotonic()+1800
            completed=None
            while time.monotonic()<deadline:
                # A completion can arrive before turn/start's response.
                completed=next((e for e in events if e.get('method')=='turn/completed' and e.get('params',{}).get('turn',{}).get('id')==turn_id),None)
                if completed:break
                try:events.append(rpc.next(timeout=min(60,max(1,deadline-time.monotonic()))))
                except queue.Empty:continue
            if not completed:raise TimeoutError(q['id'])
            mark['completed_at']=round(time.monotonic()-started,3)
            mark['wall_seconds']=round(time.monotonic()-sent,3)
            mark['status']=completed['params']['turn']['status']
            marks.append(mark)
            (out/'marks.json').write_text(json.dumps(marks,indent=2))
            (out/(q['id']+'-events.json')).write_text(json.dumps(events,ensure_ascii=False,indent=2))
            print(cell,q['id'],mark['status'],mark['wall_seconds'],'seconds',flush=True)
            if mark['status']!='completed':raise RuntimeError('Turn failed; no automatic model rerun: '+q['id'])
        verification_seconds+=verify_frozen(manifest)
        (out/'status.json').write_text(json.dumps({'completed_questions':len(marks),'wall_seconds':round(time.monotonic()-started,3),
            'verification_seconds':round(verification_seconds,3),'actor_wall_seconds':round(time.monotonic()-started-verification_seconds,3),
            'pre_launch_verification_seconds':round(pre_launch_verification,3),
            'thread_id':tid,'cell':cell,'valid':True},indent=2))
    except BaseException as e:
        (out/'status.json').write_text(json.dumps({'completed_questions':len(marks),'wall_seconds':round(time.monotonic()-started,3),
            'verification_seconds':round(verification_seconds,3),'actor_wall_seconds':round(time.monotonic()-started-verification_seconds,3),
            'pre_launch_verification_seconds':round(pre_launch_verification,3),
            'cell':cell,'valid':False,'error':str(e)},indent=2))
        raise
    finally:rpc.close()

if __name__=='__main__':
    if sys.argv[1]=='prepare-questions':prepare_questions()
    elif sys.argv[1]=='run':execute(sys.argv[2])
    elif sys.argv[1]=='run-pair':
        assert not any((BASE/'runs'/c).exists() for c in ['A','B']),'Fresh pair only; no reruns'
        execute('A');execute('B')
