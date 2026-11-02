#!/usr/bin/env python3
"""Copy run artifacts into the benchmark dir: gzipped stream + actor input, tool audit, status, bd log, grade.

usage: persist.py <runs-root> <dest-root>
"""
import gzip, shutil, subprocess, sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
runs, dest = Path(sys.argv[1]), Path(sys.argv[2])
for arm_dir in sorted(p for p in runs.iterdir() if p.is_dir()):
    for case_dir in sorted(p for p in arm_dir.iterdir() if p.is_dir()):
        out = dest / ("claude-" + arm_dir.name) / case_dir.name
        out.mkdir(parents=True, exist_ok=True)
        for name in ("stream.jsonl", "actor-input.txt"):
            src = case_dir / name
            if src.exists():
                with src.open("rb") as fi, gzip.open(out / (name + ".gz"), "wb") as fo:
                    shutil.copyfileobj(fi, fo)
        for name in ("fixture-tool-audit.jsonl", "status.json", "bd-calls.log"):
            if (case_dir / name).exists():
                shutil.copy(case_dir / name, out / name)
        grade = subprocess.run([sys.executable, "-I", str(BASE / "grade.py"), str(case_dir), case_dir.name],
                               capture_output=True, text=True, check=True).stdout
        (out / "grade.json").write_text(grade)
        print("persisted", out)
