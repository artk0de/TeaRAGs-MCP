"""Lossless evidence storage: keep captured TS out of source/test discovery."""
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

root = Path(__file__).resolve().parents[1]
base = root / '.claude-plugin/.benchmarks/tool-orchestration/2026-10-30'
backup = root / '.tmp/tea-rags539-evidence-original'
backup.mkdir(exist_ok=False)
proofs = []
for name in ['metadata-search-results', 'orchestration-results', 'native-v2', 'projection-results', 'policy-scope-results']:
    folder = base / name
    files = sorted(p for p in folder.rglob('*') if p.is_file())
    assert files and not any(p.is_symlink() for p in folder.rglob('*'))
    before = {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    total = sum(p.stat().st_size for p in files)
    archive = backup / (name + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as out:
        for path in files:
            out.add(path, arcname=str(path.relative_to(folder)), recursive=False)
    with tarfile.open(archive, 'r:gz') as inp:
        members = inp.getmembers()
        assert all(m.isfile() for m in members)
        after = {m.name: hashlib.sha256(inp.extractfile(m).read()).hexdigest() for m in members}
    assert before == after, name + ': archived bytes changed'
    saved = backup / name
    folder.rename(saved)
    folder.mkdir()
    # Keep original summaries, grades and inventories directly reviewable.
    for path in saved.iterdir():
        if path.is_file() and path.suffix not in {'.ts', '.js', '.mts', '.mjs', '.diff'}:
            shutil.copyfile(path, folder / path.name)
    shutil.copyfile(archive, folder / 'evidence.tar.gz')
    record = {'directory': name, 'original_files': len(before), 'original_bytes': total,
              'archive': 'evidence.tar.gz', 'archive_bytes': archive.stat().st_size,
              'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'all_original_member_bytes_verified': True,
              'member_inventory_sha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
              'original_inner_inventories_unchanged': True}
    (folder / 'STORAGE.json').write_text(json.dumps(record, indent=2) + '\n')
    (folder / 'STORAGE.md').write_text(
        '# Evidence storage\n\nOriginal source snapshots, fixtures, profiles and raw records are stored '
        'byte for byte in `evidence.tar.gz`. Every member SHA was compared with the original '
        'before packing. Original inner inventories are unchanged.\n\n'
        'Extract into a scratch directory before following inner reproduction paths or '
        'verifying the original inventories; keep captured TypeScript outside the repository '
        'so it does not participate in lint or test discovery.\n\n'
        '```sh\nmkdir -p /tmp/tea-rags-evidence-' + name + '\n'
        'tar -xzf evidence.tar.gz -C /tmp/tea-rags-evidence-' + name + '\n```\n')
    proofs.append(record)
(base / 'evidence-storage.json').write_text(json.dumps(proofs, indent=2) + '\n')
print(json.dumps({'archives': len(proofs), 'files_verified': sum(p['original_files'] for p in proofs),
                  'original_bytes': sum(p['original_bytes'] for p in proofs),
                  'archive_bytes': sum(p['archive_bytes'] for p in proofs)}))
