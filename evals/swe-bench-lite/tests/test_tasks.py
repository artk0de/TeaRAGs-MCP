from swe_lite_ab.tasks import Task, gold_files, mentions_gold_file, select_stratified

PATCH = """diff --git a/requests/models.py b/requests/models.py
--- a/requests/models.py
+++ b/requests/models.py
@@ -1 +1 @@
-a
+b
diff --git a/requests/utils.py b/requests/utils.py
--- a/requests/utils.py
+++ b/requests/utils.py
@@ -1 +1 @@
-a
+b
"""


def task(i, repo="psf/requests", text="", patch=PATCH):
    return Task(f"{repo.split('/')[1]}-{i}", repo, f"sha{i}", text, patch, f"2020-01-{i % 28 + 1:02d}")


def test_gold_files_lists_every_patched_file():
    assert gold_files(PATCH) == ["requests/models.py", "requests/utils.py"]


def test_mentions_gold_file_matches_basename_or_path():
    assert mentions_gold_file(task(1, text="crash in models.py line 3"))
    assert mentions_gold_file(task(2, text="see requests/utils.py"))
    assert not mentions_gold_file(task(3, text="Session drops cookies"))


def test_select_stratified_is_deterministic_and_proportional():
    pool = [task(i, "a/x", text="x.py" if i % 2 else "") for i in range(60)] + \
           [task(i, "b/y", text="") for i in range(60, 80)]
    first = select_stratified(pool, n=20, seed=7)
    assert [t.instance_id for t in first] == [t.instance_id for t in select_stratified(pool, n=20, seed=7)]
    assert len(first) == 20
    assert sum(t.repo == "a/x" for t in first) == 15  # 60/80 of 20


def test_select_stratified_honours_exclude():
    pool = [task(i) for i in range(30)]
    dev = select_stratified(pool, n=5, seed=1)
    pilot = select_stratified(pool, n=20, seed=1, exclude=frozenset(t.instance_id for t in dev))
    assert not {t.instance_id for t in dev} & {t.instance_id for t in pilot}
