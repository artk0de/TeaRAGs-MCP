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


def _focus_pool():
    named = [task(i, "django/django", text="see models.py") for i in range(4)]
    not_named = [task(i, "django/django", text="queryset bug") for i in range(4, 20)]
    other = [task(i, "psf/requests", text=t) for i, t in ((20, "models.py"), (21, "nothing"))]
    return named + not_named + other


def test_select_focus_samples_not_named_and_keeps_every_named_task():
    from swe_lite_ab.tasks import select_focus

    pool = _focus_pool()
    not_named, named = select_focus(pool, "django/django", n_not_named=5, seed=3)
    assert (not_named, named) == select_focus(list(reversed(pool)), "django/django", n_not_named=5, seed=3)
    assert [t.instance_id for t in named] == sorted(f"django-{i}" for i in range(4))
    assert len(not_named) == 5 and not any(mentions_gold_file(t) for t in not_named)
    assert {t.repo for t in not_named + named} == {"django/django"}
    assert [t.instance_id for t in not_named] == sorted(t.instance_id for t in not_named)


def test_select_focus_honours_exclude_and_stays_disjoint():
    from swe_lite_ab.tasks import select_focus

    pool = _focus_pool()
    dev, _ = select_focus(pool, "django/django", n_not_named=5, seed=3)
    scored, named = select_focus(pool, "django/django", n_not_named=11, seed=3,
                                 exclude=frozenset(t.instance_id for t in dev))
    dev_ids = {t.instance_id for t in dev}
    assert not dev_ids & {t.instance_id for t in scored + named}
    assert len(scored) == 11


def test_select_focus_raises_when_too_few_not_named_tasks():
    import pytest

    from swe_lite_ab.tasks import select_focus

    with pytest.raises(ValueError):
        select_focus(_focus_pool(), "django/django", n_not_named=17, seed=3)
