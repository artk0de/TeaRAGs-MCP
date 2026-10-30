import json
import subprocess

out = subprocess.run(["tea-rags", "projects", "list", "--json"], capture_output=True, text=True).stdout
projects = json.loads(out[out.index("["):])
bench = [p for p in projects if str(p.get("path", "")).startswith(("/Users/Shared/swe-lite", "/Users/Shared/swe-spike"))
         or str(p.get("name", "")).startswith("swe-")]
for p in bench:
    print(p.get("name"), p.get("collectionName"), p.get("path"))
print("benchmark projects:", len(bench), "of", len(projects))
print("non-benchmark (kept):", sorted(str(p.get("name")) for p in projects if p not in bench))
