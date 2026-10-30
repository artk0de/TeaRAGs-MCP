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


def test_load_lite_snapshots_the_dataset_once_and_then_reads_offline(tmp_path, monkeypatch):
    from swe_lite_ab import config, tasks

    monkeypatch.setattr(config, "LITE_SNAPSHOT", tmp_path / "lite.jsonl")
    rows = [Task("o__r-1", "o/r", "abc", "issue", PATCH, "2020-01-01")]
    calls = []
    monkeypatch.setattr(tasks, "_fetch_lite", lambda: calls.append(1) or rows)

    first = tasks.load_lite()
    second = tasks.load_lite()

    assert first == second == rows
    assert calls == [1]
    assert (tmp_path / "lite.jsonl").exists()


BIG_PATCH = "".join(f"diff --git a/pkg/m{i}.py b/pkg/m{i}.py\n--- a/pkg/m{i}.py\n+++ b/pkg/m{i}.py\n@@ -1 +1,20 @@\n"
                    + "".join(f"+line {j}\n" for j in range(20)) for i in range(2))


def test_patch_size_counts_files_and_changed_lines_without_headers():
    from swe_lite_ab.tasks import patch_size

    assert patch_size(PATCH) == (2, 4)
    assert patch_size(BIG_PATCH) == (2, 40)


def test_stratum_splits_by_patch_size_and_issue_kind():
    from swe_lite_ab.tasks import stratum

    assert stratum(task(1, text="Crash: TypeError raised on update", patch=BIG_PATCH)) == "large-bug"
    assert stratum(task(2, text="Add a --dry-run option", patch=BIG_PATCH)) == "large-feature"
    assert stratum(task(3, text="update fails with a traceback")) == "small-bug"
    assert stratum(task(4, text="Support YAML anchors")) == "small-feature"


def test_select_rebench_keeps_every_large_task_and_samples_small_bugs_since_a_date():
    from swe_lite_ab.tasks import select_rebench

    def t(i, created, text, patch):
        return Task(f"o__r-{i}", "o/r", f"sha{i}", text, patch, created)

    pool = [t(1, "2025-12-31 10:00:00", "crash", BIG_PATCH), t(2, "2026-01-02 10:00:00", "crash", BIG_PATCH),
            t(3, "2026-02-01 10:00:00", "add option", BIG_PATCH)] + \
           [t(10 + i, "2026-03-01 10:00:00", "it fails", PATCH) for i in range(10)] + \
           [t(30, "2026-03-01 10:00:00", "add option", PATCH)]

    chosen = select_rebench(pool, since="2026-01", n_small_bug=4, seed=5)

    ids = [x.instance_id for x in chosen]
    assert ids == sorted(ids)
    assert {"o__r-2", "o__r-3"} <= set(ids) and "o__r-1" not in ids and "o__r-30" not in ids
    assert len(ids) == 6
    assert ids == [x.instance_id for x in select_rebench(pool, since="2026-01", n_small_bug=4, seed=5)]


def test_task_list_records_its_dataset_and_legacy_lists_mean_lite(tmp_path):
    import json

    from swe_lite_ab.tasks import load_task_list, save_task_list

    save_task_list([task(1), task(2)], tmp_path / "r.json", "rebench")
    assert load_task_list(tmp_path / "r.json") == ("rebench", ["requests-1", "requests-2"])
    (tmp_path / "l.json").write_text(json.dumps(["a__b-1"]))
    assert load_task_list(tmp_path / "l.json") == ("lite", ["a__b-1"])


def test_stratum_takes_the_kind_from_the_task_when_the_dataset_labels_it():
    from swe_lite_ab.tasks import stratum

    labelled_feature = Task("p-1", "o/r", "sha", "Crash: TypeError raised", BIG_PATCH, "", kind="feature")
    labelled_bug = Task("p-2", "o/r", "sha", "Support YAML anchors", PATCH, "", kind="bug")
    assert stratum(labelled_feature) == "large-feature"
    assert stratum(labelled_bug) == "small-bug"


def test_load_dispatches_pro_to_the_pro_snapshot(monkeypatch):
    from swe_lite_ab import pro, tasks

    monkeypatch.setattr(pro, "load", lambda: ["pro-task"])
    assert tasks.load("pro") == ["pro-task"]
