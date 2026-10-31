"""Offline persistence tests; never starts an RPC/model client."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from controller_io import EventJournal, recover_journal, runtime_identity, verify_runtime

HERE = Path(__file__).resolve().parent

class PersistenceTests(unittest.TestCase):
    def test_event_fidelity_order_and_duplicate_events(self):
        events = [{'method':'one','params':{'text':'Привет\n世界','n':[1,None,True]}},
                  {'method':'two','params':{}}, {'method':'two','params':{}}]
        untouched = copy.deepcopy(events)
        with tempfile.TemporaryDirectory() as d:
            journal = EventJournal(d, 'Q01')
            for event in events:
                journal.append(event)
            self.assertEqual(recover_journal(journal.path)['events'], events)
            self.assertEqual(events, untouched)
            self.assertFalse((Path(d)/'Q01-events.json').exists())
            self.assertFalse((Path(d)/'Q01-partial-events.json').exists())
            journal.complete(events)
            self.assertEqual(json.loads((Path(d)/'Q01-events.json').read_text()), events)
            self.assertEqual(recover_journal(journal.path)['events'], events)
            self.assertEqual(journal.observations()['event_count'], 3)
            self.assertEqual(journal.observations()['snapshot_count'], 1)

    def test_flushed_records_survive_process_crash_without_close(self):
        with tempfile.TemporaryDirectory() as d:
            code = ('import os,sys; from controller_io import EventJournal; '
                    'j=EventJournal(sys.argv[1],"Q01"); '
                    'j.append({"method":"kept","params":{"n":1}}); os._exit(23)')
            result = subprocess.run([sys.executable, '-c', code, d], cwd=HERE,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 23, result.stderr)
            recovery = recover_journal(Path(d)/'Q01-partial-events.jsonl')
            self.assertEqual(recovery['events'], [{'method':'kept','params':{'n':1}}])
            self.assertEqual(recovery['incomplete_tail_bytes'], 0)
            self.assertFalse((Path(d)/'Q01-events.json').exists())

    def test_incomplete_final_record_is_reported_not_silently_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'partial.jsonl'
            path.write_bytes(b'{"n":1}\n{"n":')
            recovery = recover_journal(path)
            self.assertEqual(recovery['events'], [{'n':1}])
            self.assertEqual(recovery['incomplete_tail_bytes'], 5)
            path.write_bytes(b'{"n":1}\nnot-json\n')
            with self.assertRaises(ValueError):
                recover_journal(path)

    def test_error_writes_one_partial_snapshot_without_completed_answer(self):
        with tempfile.TemporaryDirectory() as d:
            journal = EventJournal(d, 'Q01')
            journal.append({'method':'raw','params':{'unchanged':'opaque'}})
            recovery = journal.abort()
            self.assertEqual(recovery['events'], [{'method':'raw','params':{'unchanged':'opaque'}}])
            self.assertEqual(json.loads((Path(d)/'Q01-partial-events.json').read_text()), recovery['events'])
            self.assertFalse((Path(d)/'Q01-events.json').exists())
            self.assertEqual(journal.observations()['snapshot_count'], 1)

    def test_bytes_grow_linearly_without_list_rewrites_or_fsync(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(os, 'fsync', side_effect=AssertionError('no fsync')):
            sizes = []
            for n in (10, 20):
                journal = EventJournal(d, 'Q%02d' % n)
                for _ in range(n):
                    journal.append({'fixed':'x'*60})
                sizes.append(journal.path.stat().st_size)
                observed = journal.observations()
                self.assertEqual(observed['journal_bytes'], sizes[-1])
                self.assertEqual(observed['snapshot_count'], 0)
                self.assertEqual(observed['event_count'], n)
                journal.close()
            self.assertEqual(sizes[1], sizes[0]*2)
            self.assertEqual(sorted(p.suffix for p in Path(d).iterdir()), ['.jsonl','.jsonl'])

    def test_existing_journal_or_snapshot_refuses_overwrite(self):
        for suffix in ('-partial-events.jsonl', '-events.json', '-partial-events.json'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as d:
                target = Path(d)/('Q01'+suffix)
                target.write_text('retained')
                with self.assertRaises(FileExistsError):
                    EventJournal(d, 'Q01')
                self.assertEqual(target.read_text(), 'retained')

    def test_completed_snapshot_refuses_overwrite_and_append(self):
        with tempfile.TemporaryDirectory() as d:
            journal = EventJournal(d, 'Q01')
            journal.append({'n':1})
            target = Path(d)/'Q01-events.json'
            target.write_text('existing')
            with self.assertRaises(FileExistsError):
                journal.complete([{'n':1}])
            self.assertEqual(target.read_text(), 'existing')
            journal.close()
            with self.assertRaises(ValueError):
                journal.append({'n':2})

    def test_persistence_fields_are_observations_not_model_time(self):
        with tempfile.TemporaryDirectory() as d:
            journal = EventJournal(d, 'Q01')
            journal.append({'n':1})
            journal.complete([{'n':1}])
            stats = journal.observations()
            for field in ('wall_seconds','thread_cpu_seconds','append_wall_seconds','snapshot_wall_seconds'):
                self.assertGreaterEqual(stats[field], 0)
            self.assertEqual(stats['measurement'], 'OBSERVATION')
            self.assertIn('overlap', stats['limitation'])
            self.assertFalse(any('model' in key or 'net' in key for key in stats))

class RuntimeTests(unittest.TestCase):
    def test_runtime_identity_freezes_actual_interpreter(self):
        import hashlib
        identity = runtime_identity()
        self.assertEqual(identity['executable'], str(Path(sys.executable).resolve()))
        self.assertEqual(identity['executable_sha256'], hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest())
        self.assertEqual(identity['version'], sys.version)
        self.assertEqual(identity['cache_tag'], sys.implementation.cache_tag)
        self.assertIsInstance(identity['flags'], dict)
        self.assertEqual(identity['flags']['optimize'], sys.flags.optimize)
        verify_runtime(identity)

    def test_frozen_runtime_mismatch_is_rejected(self):
        for key in ('executable','executable_sha256','version','cache_tag','flags'):
            with self.subTest(key=key):
                expected = runtime_identity()
                expected[key] = {} if key == 'flags' else 'different'
                with self.assertRaisesRegex(RuntimeError, 'runtime'):
                    verify_runtime(expected)

if __name__ == '__main__':
    unittest.main()
