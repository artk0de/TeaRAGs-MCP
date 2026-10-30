#!/usr/bin/env python3
"""Archive one finished response-contract study; never starts actors or changes production."""
import argparse
import gzip
import hashlib
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent.parent
DESIGN = ROOT / '.claude-plugin/.benchmarks/response-contract/2026-10-30'
DEFAULT_STUDY = BASE / 'response-contract-runs/20261030-184546-954844000'
ARMS = ('control', 'candidate')
DESIGN_FILES = ('candidate.txt', 'evals.json', 'prereg.json', 'prereg.md')
# No recursive case/home copying. These are the entire per-case source allowlists.
CASE_FILES = {
    'actor-input.json': 'actor-input.json',
    'fixture.json': 'fixture.json',
    'preflight.json': 'preflight.json',
    'actor/status.json': 'status.json',
    'actor/thread-start.json': 'thread-start.json',
    'actor/observed-metrics.json': 'observed-metrics.json',
    'preflight-no-turn/filesystem-denials.json': 'filesystem-denials.json',
    'preflight-no-turn/filesystem-allowed.json': 'filesystem-allowed.json',
    'preflight-no-turn/codex-rules-injection-proof.json': 'codex-rules-injection-proof.json',
}
RAW_REQUIRED = {'actor/events.jsonl': 'events.jsonl.gz',
                'fixture-tool-audit.jsonl': 'fixture-tool-audit.jsonl.gz'}
RAW_OPTIONAL = {'actor/turn-events.json': 'turn-events.json.gz',
                'actor/thread-read.json': 'thread-read.json.gz'}
REPRO_FILES = {
    BASE / 'response_contract.py': 'response_contract.py',
    BASE / 'run.py': 'run.py',
    BASE / 'fixture_mcp.py': 'fixture_mcp.py',
    BASE / 'response-contract-grade.py': 'response-contract-grade.py',
    BASE / 'response-contract-quality-root.py': 'response-contract-quality-root.py',
    ROOT / '.tmp/codex61_app_rpc.py': 'codex61_app_rpc.py',
    Path(__file__).resolve(): 'archive-response-contract.py',
}
SAFE_CASE_META = ('key', 'suite', 'id', 'pair_id', 'arm', 'alias',
                  'actor_input_sha256', 'fixture_sha256', 'preflight',
                  'injection_proof', 'normalized_actor_sha256', 'normalized_fixture_sha256')
SAFE_MANIFEST = ('ROOTGO', 'model', 'effort', 'plugin_version', 'study', 'pairs',
                 'candidate_sha256', 'design_files_sha256', 'helper_sha256',
                 'runner_sha256', 'fixture_server_sha256', 'execution_runner_sha256',
                 'model_turns_prepared', 'max_workers', 'max_turn_seconds',
                 'retry_policy', 'production_edits', 'read_delay_ms',
                 'boundary_ready', 'preparation_complete', 'execution_schedule')


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path):
    require(path.is_file() and not path.is_symlink(), 'Missing/nonregular input: ' + str(path))
    return json.loads(path.read_text())


def canonical(value, meta):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return text.replace(meta['cwd'], '__CASE_CWD__').replace(meta['alias'], '__CASE_ALIAS__').encode()


def inventory(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        require(not path.is_symlink(), 'Symlink not allowed: ' + str(path))
        if path.is_file():
            result[str(path.relative_to(directory))] = digest(path.read_bytes())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study', type=Path, default=DEFAULT_STUDY)
    parser.add_argument('--output', type=Path, default=DESIGN / 'results')
    parser.add_argument('--root-ready', action='store_true', help='Root has reviewed EOF and supplied final grading JSONs')
    parser.add_argument('--metric-grade', type=Path, required=True)
    parser.add_argument('--root-quality-grade', type=Path, required=True)
    parser.add_argument('--quality-grade', type=Path, action='append', default=[], help='Additional independently authored quality JSON')
    args = parser.parse_args()
    require(args.root_ready, 'Do not archive before all 16 EOF and explicit root readiness')
    study, output = args.study.resolve(), args.output.resolve()
    require(output == (DESIGN / 'results').resolve(), 'Output is restricted to the dated results directory')
    require(not output.exists(), 'Refusing to overwrite an existing results archive')
    master = load(study / 'manifest.json')
    require(master.get('ROOTGO') and master.get('preparation_complete'), 'Study was not authorized/prepared')
    cases = master.get('cases', [])
    identities = {(x['arm'], x['key']) for x in cases}
    require(len(cases) == len(identities) == 16, 'Expected exactly 16 unique arm/case entries')
    exits = load(study / 'worker-exits.json')
    require(len(exits) == 16 and {(x['arm'], x['key']) for x in exits} == identities, 'All 16 worker EOF/exit records are required')
    grades = [(args.metric_grade.resolve(), 'grades/metric-grade.json'),
              (args.root_quality_grade.resolve(), 'grades/root-quality-grade.json')]
    grades += [(p.resolve(), f'grades/independent-quality-{i}.json') for i, p in enumerate(args.quality_grade, 1)]
    for path, _ in grades:
        require(bool(load(path)), 'Grade JSON is empty: ' + str(path))
    # Freeze-file and snapshot checks happen before creating output.
    require(set(master['design_files_sha256']) == set(DESIGN_FILES), 'Unexpected frozen-design files')
    for name in DESIGN_FILES:
        raw = (study / 'frozen-design' / name).read_bytes()
        require(digest(raw) == master['design_files_sha256'][name], 'Frozen design changed: ' + name)
        require(raw == (DESIGN / name).read_bytes(), 'Original prereg/candidate/evals differs from frozen bytes: ' + name)
    snapshots = {a: study / a / 'marketplace/harness/codex/tea-rags' for a in ARMS}
    arm_hashes = {a: inventory(snapshots[a]) for a in ARMS}
    for arm in ARMS:
        require(arm_hashes[arm] == master['arms'][arm]['plugin_sha256'], 'Frozen plugin hash mismatch: ' + arm)
    differences = sorted(k for k in set(arm_hashes['control']) | set(arm_hashes['candidate']) if arm_hashes['control'].get(k) != arm_hashes['candidate'].get(k))
    require(differences == ['scripts/codex-rules.txt'], 'Unexpected candidate plugin differences')
    candidate = (study / 'frozen-design/candidate.txt').read_bytes()
    require((snapshots['candidate'] / differences[0]).read_bytes() == (snapshots['control'] / differences[0]).read_bytes() + candidate, 'Candidate is not the exact appended contract')
    prepared, pairs = [], {}
    for meta in cases:
        require(meta['arm'] in ARMS and re.fullmatch(r'[A-Za-z0-9_-]+', meta['key']), 'Unsafe arm/case name')
        directory = study / meta['arm'] / 'cases' / meta['key']
        require(directory == Path(meta['directory']).resolve(), 'Case location differs from manifest')
        for name in (*CASE_FILES, *RAW_REQUIRED):
            path = directory / name
            require(path.is_file() and not path.is_symlink(), 'Required archive evidence missing: ' + str(path))
        status = load(directory / 'actor/status.json')
        require(status.get('attempt') == 1 and status.get('status'), 'Expected one terminal actor attempt')
        actor, fixture = load(directory / 'actor-input.json'), load(directory / 'fixture.json')
        actor_hash, fixture_hash = digest(canonical(actor, meta)), digest(canonical(fixture, meta))
        require(digest((directory / 'actor-input.json').read_bytes()) == meta['actor_input_sha256'], 'Actor bytes changed')
        require(digest((directory / 'fixture.json').read_bytes()) == meta['fixture_sha256'], 'Fixture bytes changed')
        require(actor_hash == meta['normalized_actor_sha256'] and fixture_hash == meta['normalized_fixture_sha256'], 'Normalized hashes changed')
        pair = pairs.setdefault(meta['key'], {})
        pair[meta['arm']] = {'actor_sha256': actor_hash, 'fixture_sha256': fixture_hash}
        events = [json.loads(line) for line in (directory / 'actor/events.jsonl').read_text().splitlines() if line.strip()]
        started = sum(e.get('method') == 'turn/started' for e in events)
        require(started == 1, 'Expected exactly one native actor turn per case')
        final = []
        if (directory / 'actor/thread-read.json').exists():
            state = load(directory / 'actor/thread-read.json')
            final = [i.get('text', '') for t in state.get('thread', {}).get('turns', []) for i in t.get('items', []) if i.get('type') == 'agentMessage' and i.get('phase') == 'final_answer']
        if not final:
            final = [e['params']['item'].get('text', '') for e in events if e.get('method') == 'item/completed' and e.get('params', {}).get('item', {}).get('type') == 'agentMessage' and e['params']['item'].get('phase') == 'final_answer']
        prepared.append((meta, directory, status, events, '\n\n'.join(final)))
    require(len(pairs) == 8 and all(set(p) == set(ARMS) and p['control'] == p['candidate'] for p in pairs.values()), 'A/B actor/fixture equality failed')
    for path in REPRO_FILES:
        require(path.is_file() and not path.is_symlink(), 'Repro helper missing: ' + str(path))
    for path, expected in (
        (BASE / 'run.py', master['helper_sha256']),
        (BASE / 'response_contract.py', master.get('execution_runner_sha256', master['runner_sha256'])),
        (BASE / 'fixture_mcp.py', master['fixture_server_sha256']),
    ):
        require(digest(path.read_bytes()) == expected, 'Executed helper changed; freeze the exact executed bytes before archiving: ' + str(path))
    raw_records = []
    output.mkdir(parents=True)

    def write_json(relative, value):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

    def copy(source, relative, compressed=False):
        require(source.is_file() and not source.is_symlink(), 'Nonregular copy source')
        raw = source.read_bytes()
        archived = gzip.compress(raw, mtime=0) if compressed else raw
        if compressed:
            require(digest(gzip.decompress(archived)) == digest(raw), 'Gzip SHA roundtrip failed')
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(archived)
        require(destination.read_bytes() == archived, 'Archive write mismatch')
        raw_records.append({'archive_path': relative, 'raw_sha256': digest(raw), 'archive_sha256': digest(archived), 'raw_bytes': len(raw), 'archive_bytes': len(archived), 'gzip_roundtrip_verified': compressed})

    safe_manifest = {k: master[k] for k in SAFE_MANIFEST if k in master}
    safe_manifest['cases'] = [{k: x[k] for k in SAFE_CASE_META if k in x} for x in cases]
    safe_manifest['arms'] = {a: {'plugin_sha256': arm_hashes[a], 'diff_from_control': master['arms'][a]['diff_from_control']} for a in ARMS}
    safe_manifest['source_inputs'] = {str(Path(k).relative_to(ROOT)): v for k, v in master['source_inputs'].items()}
    safe_manifest['source_manifest_sha256'] = digest((study / 'manifest.json').read_bytes())
    write_json('manifest.json', safe_manifest)
    write_json('prep-equality-proofs.json', {'pairs': pairs, 'original_proofs': master['pairs'], 'normalized_equal': True, 'candidate_plugin_only_diff': differences, 'exact_contract_append_verified': True})
    write_json('worker-exits.json', exits)
    summary = {'model': master['model'], 'effort': master['effort'], 'plugin_version': master['plugin_version'], 'case_count': 16, 'cases': []}
    for meta, directory, status, events, answer in prepared:
        prefix = 'cases/' + meta['arm'] + '/' + meta['key'] + '/'
        for source, target in CASE_FILES.items():
            copy(directory / source, prefix + target)
        for source, target in {**RAW_REQUIRED, **RAW_OPTIONAL}.items():
            if (directory / source).exists():
                copy(directory / source, prefix + target, compressed=True)
        (output / prefix / 'answer.md').write_text(answer + '\n')
        summary['cases'].append({'arm': meta['arm'], 'key': meta['key'], 'status': status, 'final_answer_present': bool(answer), 'turn_started_notifications': 1, 'hook_started_notifications': sum(e.get('method') == 'hook/started' for e in events), 'hook_completed_notifications': sum(e.get('method') == 'hook/completed' for e in events)})
    summary['completed_count'] = sum(x['status'].get('status') == 'completed' for x in summary['cases'])
    write_json('runtime-summary.json', summary)
    if (study / 'runtime-summary.json').is_file():
        copy(study / 'runtime-summary.json', 'source-runtime-summary.json')
    for arm in ARMS:
        for name in arm_hashes[arm]:
            copy(snapshots[arm] / name, 'plugin-snapshots/' + arm + '/' + name)
    for name in DESIGN_FILES:
        copy(study / 'frozen-design' / name, 'frozen-design/' + name)
    for source, relative in grades:
        copy(source, relative)
    for source, name in REPRO_FILES.items():
        copy(source, 'repro/' + name)
    write_json('raw-sha256.json', {'files': raw_records, 'notes': ['Only explicit allowlisted files are copied; no auth, actor homes, per-home configs, backend process logs or environment bundles.', 'Case manifests omit home/config/process metadata. Permitted native evidence retains its original bytes, including workspace/plugin paths and native tool IDs.']})
    # This is deliberately the last archive write. Root may add decision prose later
    # and regenerate the inventory, without touching the frozen study/design.
    hashes = inventory(output)
    listing = ''.join(f'{value}  {name}\n' for name, value in sorted(hashes.items()))
    (output / 'inventory.sha256').write_text(listing)
    require(all(digest((output / name).read_bytes()) == value for name, value in hashes.items()), 'Final inventory verification failed')
    print(json.dumps({'output': str(output), 'files': len(hashes) + 1, 'bytes': sum(p.stat().st_size for p in output.rglob('*') if p.is_file()), 'inventory_entries': len(hashes), 'inventory_sha256': digest(listing.encode()), 'completed_cases': summary['completed_count']}))


if __name__ == '__main__':
    main()
