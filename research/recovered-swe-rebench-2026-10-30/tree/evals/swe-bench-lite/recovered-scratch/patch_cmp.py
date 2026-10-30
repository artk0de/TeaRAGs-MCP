import difflib
import sys

from swe_lite_ab import config, tasks

iid = sys.argv[1]
t = next(x for x in tasks.load("pro") if x.instance_id == iid)


def changed(patch):
    return [l for l in patch.splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---")]


gold = changed(t.patch)
print("GOLD files:", tasks.gold_files(t.patch), "lines:", len(gold))
print("\n".join(gold))
for arm in ("arm0", "arm1"):
    p = (config.RUNS / arm / "patches" / f"{iid}.diff").read_text()
    ch = changed(p)
    sim = difflib.SequenceMatcher(None, "\n".join(gold), "\n".join(ch)).ratio()
    print(f"\n== {arm} files:", tasks.gold_files(p), "lines:", len(ch), f"similarity to gold: {sim:.2f}")
    print("\n".join(ch))
