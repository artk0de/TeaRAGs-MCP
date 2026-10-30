import json
from collections import Counter

from swe_lite_ab import config
from swe_lite_ab.tasks import Task, mentions_gold_file, patch_size, stratum

rows = [json.loads(l) for l in config.PRO_SNAPSHOT.read_text().splitlines() if l]
qb = [r for r in rows if r["repo"] == "qutebrowser/qutebrowser"]
fields = Task.__dataclass_fields__
tasks = [Task(**{k: r[k] for k in fields if k in r}) for r in qb]
named = [t for t in tasks if mentions_gold_file(t)]
not_named = [t for t in tasks if not mentions_gold_file(t)]
print("qutebrowser:", len(tasks), "named:", len(named), "not named:", len(not_named))
print("not-named strata:", Counter(stratum(t) for t in not_named))
print("not-named patch sizes (files, lines):", sorted(patch_size(t.patch) for t in not_named))
