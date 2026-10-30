from swe_lite_ab import config, tasks

ids = tasks.load_task_list(config.TASKS_DIR / "probe-repos.json")[1]
tuta = [t for t in tasks.load("pro") if t.instance_id in ids and t.repo == "tutao/tutanota"]
tasks.save_task_list(tuta, config.TASKS_DIR / "smoke-1.json", "pro")
t = tuta[0]
print(t.instance_id, tasks.stratum(t), tasks.patch_size(t.patch), tasks.gold_files(t.patch))
