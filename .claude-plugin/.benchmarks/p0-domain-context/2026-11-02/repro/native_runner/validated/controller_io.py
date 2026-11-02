"""Append-only controller evidence, separate from the authoritative RPC journal.

No RPC/model imports. Events remain opaque and ordered; the native protocol owns
its existing events list. Flush every record, without fsync. This protects process
crashes, not power loss. Timing fields are observations, never model-time estimates.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def runtime_identity():
    """Freeze the running executable, rather than whichever `python3` PATH finds."""
    executable = Path(sys.executable).resolve(strict=True)
    flags = {name: getattr(sys.flags, name) for name in dir(sys.flags)
             if not name.startswith('_') and type(getattr(sys.flags, name)) in (int, bool)}
    return {'executable': str(executable),
            'executable_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
            'version': sys.version, 'cache_tag': sys.implementation.cache_tag,
            'flags': flags}


def verify_runtime(expected):
    if sys.flags.optimize != 0:
        raise RuntimeError('Controller runtime forbids optimized Python (-O/PYTHONOPTIMIZE); safety assertions must remain enabled')
    actual = runtime_identity()
    if actual != expected:
        changed = sorted(key for key in set(actual) | set(expected) if actual.get(key) != expected.get(key))
        raise RuntimeError('Controller Python runtime differs from frozen identity: ' + ', '.join(changed))
    return actual


def require_controller_python():
    """Future local launches explicitly use the reviewed Homebrew Python 3.15."""
    if sys.flags.optimize != 0:
        raise RuntimeError('Controller runtime forbids optimized Python (-O/PYTHONOPTIMIZE); safety assertions must remain enabled')
    required = Path('/opt/homebrew/bin/python3').resolve(strict=True)
    if Path(sys.executable).resolve() != required or sys.version_info[:2] != (3, 15):
        raise RuntimeError('Controller runtime requires explicit /opt/homebrew/bin/python3 (Python 3.15)')
    return runtime_identity()


def recover_journal(path):
    """Read complete records; report a crash-truncated final record explicitly.

A malformed newline-terminated record is corruption and raises. A valid final
JSON value without newline is recoverable. No recovery modifies the journal.
"""
    events = []
    tail_bytes = 0
    with Path(path).open('rb') as stream:
        for number, line in enumerate(stream, 1):
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError) as error:
                if not line.endswith(b'\n'):
                    tail_bytes = len(line)
                    break
                raise ValueError('Corrupt complete journal record at line %d' % number) from error
            events.append(event)
    return {'events': events, 'incomplete_tail_bytes': tail_bytes,
            'limitation': 'Flushed process-crash recovery only; no fsync/power-loss guarantee'}


def _create_snapshot(path, events):
    """Publish one complete JSON snapshot atomically, without replacing evidence."""
    path = Path(path)
    if path.exists() or path.is_symlink():
        raise FileExistsError(str(path))
    temporary = path.with_name(path.name + '.writing')
    encoded = (json.dumps(events, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    # Exclusive temp + hard-link publication also rejects a racing final creator.
    with temporary.open('xb') as stream:
        stream.write(encoded)
        stream.flush()
    try:
        os.link(temporary, path)
    finally:
        temporary.unlink()
    return len(encoded)


class EventJournal:
    def __init__(self, directory, question_id):
        if not question_id or Path(question_id).name != question_id or question_id in ('.', '..'):
            raise ValueError('Question id must be a simple filename component')
        self.directory = Path(directory)
        self.path = self.directory / (question_id + '-partial-events.jsonl')
        self.completed_path = self.directory / (question_id + '-events.json')
        self.partial_path = self.directory / (question_id + '-partial-events.json')
        for path in (self.path, self.completed_path, self.partial_path,
                     self.completed_path.with_suffix('.json.writing'), self.partial_path.with_suffix('.json.writing')):
            if path.exists() or path.is_symlink():
                raise FileExistsError(str(path))
        self._stream = self.path.open('xb')
        self.finalized = False
        self._stats = {'event_count': 0, 'journal_bytes': 0, 'snapshot_count': 0, 'snapshot_bytes': 0,
                       'append_wall_seconds': 0.0, 'append_thread_cpu_seconds': 0.0,
                       'snapshot_wall_seconds': 0.0, 'snapshot_thread_cpu_seconds': 0.0}

    def append(self, event):
        if self._stream.closed or self.finalized:
            raise ValueError('Cannot append to a closed/finalized event journal')
        wall, cpu = time.perf_counter(), time.thread_time()
        try:
            encoded = (json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
            self._stream.write(encoded)
            self._stream.flush()
            self._stats['event_count'] += 1
            self._stats['journal_bytes'] += len(encoded)
        finally:
            self._stats['append_wall_seconds'] += time.perf_counter() - wall
            self._stats['append_thread_cpu_seconds'] += time.thread_time() - cpu

    def close(self):
        self._stream.close()

    def _snapshot(self, path, events):
        wall, cpu = time.perf_counter(), time.thread_time()
        try:
            size = _create_snapshot(path, events)
            self._stats['snapshot_count'] += 1
            self._stats['snapshot_bytes'] += size
        finally:
            self._stats['snapshot_wall_seconds'] += time.perf_counter() - wall
            self._stats['snapshot_thread_cpu_seconds'] += time.thread_time() - cpu

    def complete(self, events):
        if self.finalized:
            raise ValueError('Event journal already finalized')
        if len(events) != self._stats['event_count']:
            raise ValueError('Protocol event count differs from journal callback count')
        self.close()
        self._snapshot(self.completed_path, events)
        self.finalized = True

    def abort(self):
        if self.finalized:
            raise ValueError('Event journal already finalized')
        self.close()
        recovery = recover_journal(self.path)
        self._snapshot(self.partial_path, recovery['events'])
        self.finalized = True
        return recovery

    def observations(self):
        return {**self._stats,
                'wall_seconds': self._stats['append_wall_seconds'] + self._stats['snapshot_wall_seconds'],
                'thread_cpu_seconds': self._stats['append_thread_cpu_seconds'] + self._stats['snapshot_thread_cpu_seconds'],
                'measurement': 'OBSERVATION',
                'limitation': 'Persistence callback/snapshot timings overlap RPC/service activity; never subtract as pure model time. No fsync; RPC events.jsonl remains authoritative.'}
