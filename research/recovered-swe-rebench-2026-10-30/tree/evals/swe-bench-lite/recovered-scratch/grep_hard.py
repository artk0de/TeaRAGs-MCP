from swe_lite_ab import config, tasks

ids = [i for i in tasks.load_task_list(config.TASKS_DIR / "loc-10.json")[1] if "qutebrowser-7f9713b2" in i]
tasks.save_task_list([t for t in tasks.load("pro") if t.instance_id in ids], config.TASKS_DIR / "smoke-1.json", "pro")
print(ids)
