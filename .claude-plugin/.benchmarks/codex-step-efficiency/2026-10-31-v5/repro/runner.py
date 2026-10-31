"""One fresh A39; only sanitized original questions, no gold or retries."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import time
from protocol import await_turn, account_events, turn_outcomes
from controller_io import EventJournal, verify_runtime
from mcp_readiness import wait_for_mcp_ready
from codex61_app_rpc import RPC, REPO

ROOT = Path('/Users/artk0re/Dev/Tools/tea-rags-mcp')
BASE = None

def configure(base):
    global BASE
    BASE=Path(base).resolve()
OPENING = '''Вот доки от GruntWorx, давай зарядим SDD кит

1) Есть проблема некоторыми портами - https://taxdome.atlassian.net/browse/TD-102837, эту задачу нужно включить в спеки
2) Пока что делаем на моках, также как делали с instead_mocks
3) Нужно учесть весь опыт Instead, хотя реализации и модель будут отличаться'''

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def corpus_inventory():
    source, result = Path(REPO), {}
    for base, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if d not in {'.git', '.agents', '.codex', '.claude', 'docs', 'specs'}]
        for name in files:
            p = Path(base) / name
            if name in {'.git', '.contextignore.local'} or name.lower().endswith(('.md', '.markdown', '.mdx')):
                continue
            result[str(p.relative_to(source))] = {'link': str(p.readlink())} if p.is_symlink() else {'bytes': p.stat().st_size, 'sha256': sha(p)}
    return result

def verify_frozen(manifest):
    start = time.monotonic()
    verify_runtime(manifest['controller_python'])
    assert manifest['controller_python'] == json.loads((BASE / 'controller-python.json').read_text()), 'Controller runtime record differs from manifest'
    for name, expected in manifest['frozen_files'].items():
        assert sha(name) == expected, 'Frozen artifact changed: ' + name
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip() == manifest['corpus_commit']
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True).strip()
    assert corpus_inventory() == json.loads((BASE / 'corpus-readable-inventory.json').read_text())
    return time.monotonic() - start

def dump(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def completion(events, turn_id):
    return next((e for e in events if e.get('method') == 'turn/completed' and e.get('params', {}).get('turn', {}).get('id') == turn_id), None)

def execute(cell):
    assert BASE is not None, 'Explicit base configuration required'
    assert cell == 'A', 'A-only runner rejects every other cell before any model client'
    manifest = json.loads((BASE / 'final-manifest.json').read_text())
    assert manifest['ROOTGO'] and manifest['preflight_ready'] and manifest['independent_security_review'] == 'ready'
    assert manifest['runs_authorized'] == ['A'] and manifest['order'] == ['A'] and manifest['prepared_model_turns'] == 0
    precheck = verify_frozen(manifest)
    out = BASE / 'runs' / cell
    assert not out.exists(), 'Never retry or overwrite an actor directory'
    out.mkdir(parents=True)
    home = BASE / 'homes' / cell
    assert not (home / 'sessions').exists(), 'Fresh actor home required'
    questions = json.loads((BASE / 'questions-only.json').read_text())
    assert len(questions) == 39 and [q['id'] for q in questions] == ['Q%02d' % i for i in range(1, 40)]
    assert all(set(q) == {'id', 'question'} for q in questions)
    rpc = RPC(home, out, extra_env=manifest['backend_env'][cell], allow_model_turns=True)
    started, marks, verification = time.monotonic(), [], 0.0
    journals, active_journal = [], None
    def persistence_observation():
        observations = [journal.observations() for journal in journals]
        keys = ('event_count', 'journal_bytes', 'snapshot_count', 'snapshot_bytes', 'wall_seconds', 'thread_cpu_seconds',
                'append_wall_seconds', 'append_thread_cpu_seconds', 'snapshot_wall_seconds', 'snapshot_thread_cpu_seconds')
        return {**{key: sum(row[key] for row in observations) for key in keys},
                'measurement': 'OBSERVATION',
                'limitation': 'Controller persistence timings overlap RPC/service activity; never subtract as pure model time. Global RPC events.jsonl remains authoritative.'}
    def status(valid, **extra):
        elapsed = time.monotonic() - started
        return {'assessed_questions': len(marks), 'native_completed_turns': sum(m['native_turn_status'] == 'completed' for m in marks),
                'turns_with_observed_final_answer': sum(m['has_observed_final_answer'] for m in marks),
                'native_completed_turns_without_observed_final_answer': sum(m['native_turn_status'] == 'completed' and not m['has_observed_final_answer'] for m in marks),
                'awaiting_user_questions': sum(m['status'] == 'awaiting_user' for m in marks),
                'wall_seconds': round(elapsed, 3), 'verification_seconds': round(verification, 3),
                'actor_wall_seconds': round(elapsed - verification, 3), 'pre_launch_verification_seconds': round(precheck, 3),
                'cell': cell, 'valid': valid, 'quality': 'NOT GRADED', 'controller_persistence': persistence_observation(),
                'answer_count_limitation': 'Native turn completion does not imply an observed final answer; final text presence does not establish correctness', **extra}
    try:
        thread = rpc.call('thread/start', {'cwd': REPO, 'model': 'gpt-6.1-sol', 'permissions': 'benchmark',
            'approvalPolicy': 'never', 'ephemeral': False, 'experimentalRawEvents': True})
        assert thread['model'] == 'gpt-6.1-sol' and thread['reasoningEffort'] == 'medium'
        assert thread['activePermissionProfile']['id'] == 'benchmark' and not thread.get('instructionSources')
        tid = thread['thread']['id']
        dump(out / 'thread-start.json', thread)
        readiness = wait_for_mcp_ready(rpc, tid, manifest['real_tool_names'])
        dump(out / 'mcp-before-turn.json', readiness)
        for index, q in enumerate(questions):
            check = verify_frozen(manifest)
            verification += check
            prompt = (OPENING + '\n\n' if index == 0 else '') + q['question']
            sent = time.monotonic()
            mark = {'id': q['id'], 'sent_at': round(sent - started, 3), 'pre_turn_verification_seconds': round(check, 3),
                    'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest()}
            active_journal = EventJournal(out, q['id'])
            journals.append(active_journal)
            turn = rpc.call('turn/start', {'threadId': tid, 'cwd': REPO, 'permissions': 'benchmark', 'approvalPolicy': 'never',
                'model': 'gpt-6.1-sol', 'effort': 'medium', 'input': [{'type': 'text', 'text': prompt}]})
            turn_id = turn['turn']['id']
            mark['turn_id'] = turn_id
            # Native optional input is recorded without interrupting or replying.
            result=await_turn(rpc,turn_id,on_event=active_journal.append)
            events=result.pop('events')
            active_journal.complete(events)
            mark['controller_persistence'] = active_journal.observations()
            active_journal = None
            requests=result.pop('requests')
            mark.update(result)
            if requests:dump(out / (q['id'] + '-unanswered-user-requests.json'),requests)
            mark['accounting']=account_events(events)
            outcomes=turn_outcomes(events)
            mark['has_observed_final_answer']=turn_id in outcomes['observed_final_answer_turn_ids']
            mark['observed_final_answer_item_ids']=outcomes['observed_final_answer_item_ids']
            mark['completed_at'] = round(time.monotonic() - started, 3)
            mark['wall_seconds'] = round(time.monotonic() - sent, 3)
            marks.append(mark)
            dump(out / 'marks.json', marks)
            dump(out / 'progress.json', status(False, in_progress=True, thread_id=tid))
            print(cell, q['id'], mark['status'], mark['wall_seconds'], 'seconds', flush=True)
        verification += verify_frozen(manifest)
        dump(out / 'thread-read.json', rpc.call('thread/read', {'threadId': tid, 'includeTurns': True}))
        dump(out / 'status.json', status(True, thread_id=tid, accounting_complete=all(m['accounting']['accounting_complete'] for m in marks)))
    except BaseException as error:
        recovery = None
        if active_journal is not None and not active_journal.finalized:
            try:
                recovered = active_journal.abort()
                recovery = {key: value for key, value in recovered.items() if key != 'events'}
                recovery['recovered_event_count'] = len(recovered['events'])
            except BaseException as persistence_error:
                recovery = {'error': str(persistence_error), 'limitation': 'Per-question JSONL and global RPC journal retained; recover read-only, never retry actor'}
        dump(out / 'status.json', status(False, error=str(error), accounting_complete=False, partial_recovery=recovery, partial_evidence='events.jsonl is authoritative; per-question JSONL and completion/error snapshots retained; no retry'))
        raise
    finally:
        rpc.close()

if __name__ == '__main__':
    raise SystemExit('Use run.py --base BASE --rootgo after independent no-turn review')
