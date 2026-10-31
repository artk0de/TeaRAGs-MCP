"""One offline old/new persistence replay; opaque events, no RPC/model clients.

Only aggregate counts/times/hashes are retained. Raw temporary replay journals are
removed after fidelity checks; private event payloads are never printed/analyzed.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import tempfile
import time
from controller_io import EventJournal, recover_journal, require_controller_python


def replay(source, old_runner):
    runtime = require_controller_python()
    source, old_runner = Path(source), Path(old_runner)
    raw = source.read_bytes()
    events = json.loads(raw)
    # Execute the exact retained old dump definition, without importing its RPC.
    tree = ast.parse(old_runner.read_text())
    definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'dump')
    namespace = {'Path':Path, 'json':json}
    exec(compile(ast.Module(body=[definition], type_ignores=[]), str(old_runner), 'exec'), namespace)
    old_dump = namespace['dump']
    def measured(function, *args):
        wall, cpu = time.perf_counter(), time.thread_time()
        function(*args)
        return time.perf_counter()-wall, time.thread_time()-cpu
    with tempfile.TemporaryDirectory(prefix='controller-io-replay-') as folder:
        folder=Path(folder);old=folder/'old';new=folder/'new';old.mkdir();new.mkdir()
        observed=[];old_wall=old_cpu=0.0;old_bytes=0
        for event in events:
            def persist():
                observed.append(event)
                old_dump(old/'Q01-partial-events.json', observed)
            wall,cpu=measured(persist);old_wall+=wall;old_cpu+=cpu
            old_bytes+=(old/'Q01-partial-events.json').stat().st_size
        wall,cpu=measured(old_dump,old/'Q01-events.json',events)
        old_wall+=wall;old_cpu+=cpu;old_bytes+=(old/'Q01-events.json').stat().st_size
        journal=EventJournal(new,'Q01');new_wall=new_cpu=0.0
        for event in events:
            wall,cpu=measured(journal.append,event);new_wall+=wall;new_cpu+=cpu
        wall,cpu=measured(journal.complete,events);new_wall+=wall;new_cpu+=cpu
        assert json.loads((old/'Q01-events.json').read_bytes())==events
        assert json.loads((new/'Q01-events.json').read_bytes())==events
        assert recover_journal(journal.path)['events']==events
        assert len(observed)==len(events)
        stats=journal.observations()
        return {'measurement':'OBSERVATION','source':str(source.resolve()),
                'source_sha256':hashlib.sha256(raw).hexdigest(),'source_bytes':len(raw),'event_count':len(events),
                'controller_python':runtime,'same_interpreter_for_both':True,
                'old_runner_sha256':hashlib.sha256(old_runner.read_bytes()).hexdigest(),
                'new_helper_sha256':hashlib.sha256(Path(__file__).with_name('controller_io.py').read_bytes()).hexdigest(),
                'old':{'persistence_wall_seconds':old_wall,'persistence_thread_cpu_seconds':old_cpu,
                       'bytes_written':old_bytes,'full_list_snapshots':len(events)+1},
                'new':{'persistence_wall_seconds':new_wall,'persistence_thread_cpu_seconds':new_cpu,
                       'bytes_written':stats['journal_bytes']+stats['snapshot_bytes'],
                       'full_list_snapshots':stats['snapshot_count'],'helper_observations':stats},
                'fidelity':{'old_snapshot_equals_input':True,'new_snapshot_equals_input':True,'new_journal_equals_input':True},
                'limitations':['Single offline replay, old then new; warm cache/order and system load uncontrolled',
                               'No live RPC/model overlap reproduced; callback CPU is not subtracted from historical wall time',
                               'No historical timing gap attribution or model-efficiency claim',
                               'Input events treated opaquely; no private reasoning analysis or payload output']}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--old-runner',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    # Refuse an existing report before spending a replay; evidence is never replaced.
    with args.output.open('x') as stream:
        result=replay(args.source,args.old_runner)
        stream.write(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print('OFFLINE_IO_REPLAY',result['event_count'],'events; fidelity PASS; report',args.output)

if __name__=='__main__':main()
