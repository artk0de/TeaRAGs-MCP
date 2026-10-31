"""Explicit, post-actor evidence publication. No clients and no import-time work.

Selection uses paths, never credential/content scans. Native events are opaque
bytes: no JSON parsing, reasoning inspection, rewriting or payload printing.
"""
import argparse
import fnmatch
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile


ROOT_FILES = {
    'short_native.py', 'short_native_ready.py', 'mcp_readiness.py',
    'collect_visible.py', 'freeze_candidate.py',
    'seal_queued_summary.py', 'optimization-guard-proof.json',
    'static-no-turn-proof.json', 'summary.json', 'comparison.json',
    'paired-comparison.json', 'rootgo.json', 'completion.json',
    'flat-Q21-depth-review.json', 'Q34-coverage-addendum.json',
    'baseline-Q21-depth-superseding-addendum.json',
    'baseline-Q21-depth-superseding-addendum.md', 'three-variant-comparison.md',
}
ROOT_PATTERNS = ('*-summary.json', '*-verdicts.json', '*-verdicts.md',
                 '*-rootgo.json', '*-comparison.json', '*-grades.json')
SOURCE_VARIANTS = ('current-policy', 'queued-evidence-policy',
                   'queued-evidence-policy-static0', 'flat-evidence-policy')
SOURCE_FILES = ('provenance.json', 'generator-source.ts', 'package.json', '.prettierrc',
                '.agents/plugins/marketplace.json', 'scripts/gen-harness-codex.ts')
SOURCE_TREES = ('harness/codex', 'plugins/tea-rags', 'scripts/harness')
TEXT_SUFFIXES = {'.py', '.ts', '.js', '.mjs', '.json', '.jsonl', '.md', '.txt',
                 '.sh', '.ere', '.yml', '.yaml', '.toml'}
CASE_FILES = {
    'manifest.json', 'pre-optimize-guard-manifest.json',
    'pre-absolute-path-seal-manifest.json', 'pre-validation-seal-manifest.json',
    'actor-prompt.txt', 'questions-only.json', 'actor-native-install.json',
    'actor-hooks-before-trust.json', 'final-proof-summary.json',
    'no-model-failure.json', 'proxy-actor-audit.jsonl',
}
ACTOR_FILES = {'events.jsonl', 'events-final.json', 'answer.txt', 'observations.json',
               'thread-start.json', 'thread-read.json', 'status.json', 'accounting.json',
               'visible-evidence.json', 'outer-visibility-proof.json',
               'Q21-body-visibility-proof.json', 'stderr.txt', 'error.json',
               'failure.json', 'unanswered-user-requests.json', 'mcp-before-turn.json'}
PROOF_FILES = {'events.jsonl', 'filesystem-denials.json', 'filesystem-positive-source.json',
               'hooks.json', 'mcp.json', 'plugins.json', 'protected-paths.json',
               'session-codex-rules.sh-stdout.json', 'session-start.sh-stdout.json',
               'skills.json', 'stderr.txt', 'thread-start.json', 'turn-routing.sh-stdout.json'}
LIB_FILES = ('codex61_app_rpc.py', 'codex61_cli.py', 'codex61_context_metrics.py',
             'codex61_mcp_proxy.py', 'codex61_metrics.py', 'codex61_runner.py',
             'protocol.py', 'controller_io.py', 'mcp_readiness.py',
             'codex61/metadata-table-schemas.json')
PRUNED = {'home', 'homes', 'proof-homes', 'private', 'node_modules', '__pycache__',
          '.git', 'build', 'runtime', 'final-runtime', 'final-marketplace', 'cache',
          'index', 'auth', 'bin-actor'}
EXCLUDED = [
    'Homes/auth/config.toml and all other unlisted credential-bearing configuration files',
    'private/ and proxy-actor-upstream-private-stderr.txt; no content-based auth scan',
    'Executables, binaries, runtime/build, node_modules, caches, indexes, __pycache__',
    'Per-case installed/package copies: source snapshots + plugin inventories retain provenance',
    'Unlisted files, lock files, symlinks, archive outputs and inventory sidecars',
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def is_regular(path, root):
    """Reject links in any selected path component; never follow them outside root."""
    relative = path.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise RuntimeError('Selected path contains a symlink: ' + str(relative))
    return stat.S_ISREG(path.stat().st_mode)


def selected_files(root, extra_root):
    selected = set()

    def add(relative):
        path = root / relative
        if path.exists() or path.is_symlink():
            if not is_regular(path, root):
                raise RuntimeError('Selected path is not a regular file: ' + str(relative))
            selected.add(path.relative_to(root).as_posix())

    for path in root.iterdir():
        if path.name in ROOT_FILES or any(fnmatch.fnmatchcase(path.name, p) for p in ROOT_PATTERNS):
            add(path.name)
    for name in extra_root:
        if Path(name).name != name or name in ('.', '..') or Path(name).suffix not in {'.json', '.md', '.txt', '.py'}:
            raise ValueError('Extra root file must be an individually approved text basename')
        if any(word in name.lower() for word in ('auth', 'credential', 'secret', 'config', 'stderr')):
            raise ValueError('Credential/config/stderr names cannot be extra root files')
        if not (root / name).is_file():
            raise FileNotFoundError(name)
        add(name)
    for path in (root / 'versions').glob('short_native-*.py'):
        add(path.relative_to(root))
    for variant in SOURCE_VARIANTS:
        base = Path('sources') / variant
        for name in SOURCE_FILES:
            add(base / name)
        for tree in SOURCE_TREES:
            directory = root / base / tree
            if directory.is_symlink():
                raise RuntimeError('Source tree is a symlink: ' + str(base / tree))
            if not directory.exists():
                continue
            for parent, directories, files in os.walk(directory, followlinks=False):
                directories[:] = sorted(d for d in directories if d not in PRUNED
                                        and not (Path(parent) / d).is_symlink())
                for name in sorted(files):
                    if Path(name).suffix in TEXT_SUFFIXES:
                        add((Path(parent) / name).relative_to(root))
    for group in ('prepared', 'failed-no-model'):
        top = root / group
        if not top.exists():
            continue
        if top.is_symlink():
            raise RuntimeError('Evidence group is a symlink')
        for variant in sorted(top.iterdir()):
            if variant.is_symlink():
                raise RuntimeError('Variant is a symlink')
            if not variant.is_dir():
                continue
            for case in sorted(variant.iterdir()):
                if case.is_symlink():
                    raise RuntimeError('Case is a symlink')
                if not case.is_dir():
                    continue
                base = case.relative_to(root)
                for name in CASE_FILES:
                    add(base / name)
                for directory, names in (
                    ('actor', ACTOR_FILES), ('final-proof-A', PROOF_FILES),
                    ('controller-denial-proof', {'events.jsonl', 'result.json', 'stderr.txt'}),
                    ('hook-hashes-actor', {'events.jsonl', 'stderr.txt'}),
                ):
                    for name in names:
                        add(base / directory / name)
                for name in LIB_FILES:
                    add(base / 'lib' / name)
    required = {'short_native.py', 'versions/short_native-4aaf.py'}
    if not required <= selected:
        raise RuntimeError('Exact current and 4aaf controllers are required')
    if not any('/actor/events.jsonl' in name for name in selected):
        raise RuntimeError('No actor event evidence selected')
    return sorted(selected)


def load_bytes(path):
    """Read exact bytes through a no-follow descriptor, checking concurrent changes."""
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        before = os.fstat(stream.fileno())
        data = stream.read()
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise RuntimeError('Selected file changed during read: ' + str(path))
    if len(data) != before.st_size:
        raise RuntimeError('Incomplete read: ' + str(path))
    return data


def publish(temporary, final):
    # Same-directory exclusive publication refuses existing files and symlinks.
    os.link(temporary, final)
    temporary.unlink()


def archive(root, output, extra_root):
    root, output = root.resolve(strict=True), output.resolve(strict=True)
    if root == output or root in output.parents or output in root.parents:
        raise ValueError('Source and canonical output must be separate, non-nested directories')
    names = selected_files(root, extra_root)
    finals = [output / n for n in ('native-evals.tar.gz', 'native-evals-inventory.json',
                                  'native-evals.sha256', 'native-evals-complete.json')]
    for path in finals:
        if path.exists() or path.is_symlink() or path.with_name(path.name + '.writing').exists():
            raise FileExistsError(str(path))
    # Persistent attempt token: no silent retry/overwrite after interruption.
    with (output / '.native-evals-archive.lock').open('x') as stream:
        stream.write('Explicit post-actor archive attempt; retain partial files on failure.\n')
    temporary = finals[0].with_name(finals[0].name + '.writing')
    inventory, duplicates = [], {}
    with temporary.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as tar:
                for name in names:
                    path = root / name
                    is_regular(path, root)
                    data = load_bytes(path)
                    sha = digest(data)
                    info = tarfile.TarInfo(name)
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    info.mode = 0o644
                    row = {'path': name, 'sha256': sha, 'raw_bytes': len(data)}
                    key = (sha, len(data))
                    if key in duplicates:
                        info.type, info.linkname = tarfile.LNKTYPE, duplicates[key]
                        row['duplicate_of'] = info.linkname
                        tar.addfile(info)
                    else:
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                        duplicates[key] = name
                    inventory.append(row)
    # Verify every archive member bytewise, including resolved duplicate members.
    with tarfile.open(temporary, 'r:gz') as tar:
        members = tar.getmembers()
        if [m.name for m in members] != names:
            raise RuntimeError('Archive member paths/order differ from selection')
        for row, member in zip(inventory, members):
            archived = tar.extractfile(member).read()
            if len(archived) != row['raw_bytes'] or digest(archived) != row['sha256']:
                raise RuntimeError('Archive member verification failed: ' + row['path'])
            path = root / row['path']
            is_regular(path, root)
            if digest(load_bytes(path)) != row['sha256']:
                raise RuntimeError('Source changed after packing: ' + row['path'])
    if selected_files(root, extra_root) != names:
        raise RuntimeError('Selected source inventory changed while packing')
    archive_sha = digest(load_bytes(temporary))
    report = {'schema_version': 1, 'source_root': str(root), 'archive': finals[0].name,
              'archive_sha256': archive_sha, 'selected_file_count': len(inventory),
              'raw_bytes': sum(row['raw_bytes'] for row in inventory),
              'unique_payload_count': len(duplicates), 'files': inventory,
              'explicit_extra_root_files': extra_root, 'excluded_categories': EXCLUDED,
              'selection': 'Explicit path allowlist; duplicate bytes represented by tar hardlinks with original paths retained',
              'limitations': ['Explicit root attests all actors finished; no process/model inspection by archiver',
                              'Runtime executables, credentials, installed homes and live index are not bundled',
                              'Raw native events are opaque, unparsed and not payload-printed',
                              'Cases/grading/protocol remain separate canonical files, not injected into actor evidence',
                              'Hashes verify selected bytes; excluded/unlisted files are not inspected',
                              'No fsync/power-loss guarantee; completion marker is published last']}
    payloads = [None, (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode(),
                (archive_sha + '  ' + finals[0].name + '\n').encode(),
                (json.dumps({'complete': True, 'archive_sha256': archive_sha,
                             'inventory_sha256': digest((json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode())},
                            indent=2) + '\n').encode()]
    for final, data in zip(finals[1:], payloads[1:]):
        with final.with_name(final.name + '.writing').open('xb') as stream:
            stream.write(data)
    for final in finals:
        publish(final.with_name(final.name + '.writing'), final)
    print(json.dumps({'archive': str(finals[0]), 'sha256': archive_sha,
                      'selected_file_count': len(inventory), 'complete': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--extra-root-file', action='append', default=[])
    parser.add_argument('--rootgo', action='store_true', required=True)
    parser.add_argument('--actors-finished', action='store_true', required=True)
    args = parser.parse_args()
    archive(args.source, args.output_dir, args.extra_root_file)


if __name__ == '__main__':
    main()
