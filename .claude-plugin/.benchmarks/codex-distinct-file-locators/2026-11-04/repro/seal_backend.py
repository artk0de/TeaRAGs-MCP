"""Seal this experiment's compiled backend; exact prior runtime path inventory."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--source", type=Path, required=True)
p.add_argument("--dest", type=Path, required=True)
a = p.parse_args()
wt, dest = a.source.resolve(), a.dest.resolve()
old = Path("/Users/Shared/nav-ab/gruntworx-A0554-isolated-20261103-01/source/final-manifest.json")
baseline = json.loads(old.read_text())
expected = {name.split("/final-runtime/", 1)[1] for name in baseline["frozen_files"]}
assert len(expected) == 7879
allowed = {
    "src/core/api/internal/ops/explore-ops.ts", "src/core/api/public/dto/explore.ts",
    "src/core/api/tools/schemas.ts", "src/core/domains/explore/strategies/hybrid.ts",
    "src/core/domains/explore/strategies/query-variant-search.ts",
    "src/core/domains/explore/strategies/types.ts", "src/core/domains/explore/strategies/vector.ts",
    "src/core/contracts/types/search-result.ts", "src/core/domains/explore/confidence.ts",
}
changed = set(subprocess.check_output(["git", "diff", "--name-only", "HEAD", "--", "src"], cwd=wt, text=True).splitlines())
assert changed == allowed, (changed, allowed)
patch = subprocess.check_output(["git", "diff", "HEAD", "--", "src"], cwd=wt)
assert patch
dest.mkdir(parents=True, exist_ok=False)
shutil.copytree(wt / "build", dest / "build")
for name in ("package.json", ".qdrant-required-version"):
    shutil.copy2(wt / name, dest / name)
actual = {str(path.relative_to(dest)) for path in dest.rglob("*") if path.is_file()}
assert actual == expected, {"missing": sorted(expected-actual), "extra": sorted(actual-expected)}
frozen = {str(dest / name): hashlib.sha256((dest / name).read_bytes()).hexdigest() for name in sorted(expected)}
(dest / "node_modules").symlink_to((wt / "node_modules").resolve(), target_is_directory=True)
manifest = {
    "runtime_root": str(dest),
    "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=wt, text=True).strip(),
    "source_state": "base commit plus recorded uncommitted production patch; compiled in this worktree",
    "source_patch_sha256": hashlib.sha256(patch).hexdigest(),
    "changed_source_files": sorted(changed),
    "corpus_commit": baseline["corpus_commit"],
    "plugin_version": "0.55.8", "model": "gpt-6.1-sol", "effort": "medium",
    "dependencies": "Unchanged existing node_modules symlink; native Node/CLI binaries independently pinned by the controller",
    "frozen_files": frozen,
}
(dest.parent / "backend-source.patch").write_bytes(patch)
(dest.parent / "backend-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"runtime": str(dest), "frozen_files": len(frozen), "source_patch_sha256": manifest["source_patch_sha256"]}))
