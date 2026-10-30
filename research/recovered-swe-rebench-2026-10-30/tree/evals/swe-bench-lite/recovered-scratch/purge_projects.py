import json
import subprocess

out = subprocess.run(["tea-rags", "projects", "list", "--json"], capture_output=True, text=True).stdout
projects = json.loads(out[out.index("["):])
bench = [p for p in projects if str(p.get("path", "")).startswith("/Users/Shared/swe-lite-ab/")]
for p in bench:
    r = subprocess.run(["tea-rags", "projects", "unregister", "--name", p["name"], "--purge"],
                       capture_output=True, text=True)
    print(r.returncode, p["name"][:60], (r.stdout + r.stderr).strip().splitlines()[-1:] if r.returncode else "")
