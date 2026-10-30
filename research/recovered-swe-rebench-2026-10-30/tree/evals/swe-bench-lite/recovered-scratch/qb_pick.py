import json

from swe_lite_ab import config
from swe_lite_ab.tasks import Task, gold_files, mentions_gold_file, patch_size, stratum

rows = [json.loads(l) for l in config.PRO_SNAPSHOT.read_text().splitlines() if l]
fields = Task.__dataclass_fields__
for r in rows:
    if r["repo"] != "qutebrowser/qutebrowser":
        continue
    t = Task(**{k: r[k] for k in fields if k in r})
    if not mentions_gold_file(t) and patch_size(t.patch)[0] >= 3:
        print(t.instance_id, stratum(t), patch_size(t.patch), gold_files(t.patch), r.get("hard"))
