"""Build an UNSHIPPED hook-only policy variant; never modify installed hooks."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess

p = argparse.ArgumentParser()
p.add_argument("source", type=Path)
p.add_argument("destination", type=Path)
a = p.parse_args()
a.destination.mkdir(parents=True, exist_ok=False)
shutil.copytree(a.source / "harness/codex", a.destination / "harness/codex")
shutil.copytree(a.source / ".agents", a.destination / ".agents")
hook = a.destination / "harness/codex/tea-rags/scripts/one-file-read.sh"
code = hook.read_text()
definition = '''
def bounded_head(command):
    parts = list(segments(command))
    if len(parts) != 1:
        return False
    words = parts[0]
    if len(words) != 5 or os.path.basename(words[0]) != "head" or words[1] != "-c":
        return False
    if not re.fullmatch(r"[0-9]+", words[2]):
        return False
    paths = words[3:]
    if any(not MD_TOKEN.search(path) or path.startswith("-") or re.search(r"[*?\\[$`\\n]", path) for path in paths):
        return False
    # head emits at most N bytes per file plus literal filename headers.
    # Count UTF-8 bytes, not lines/tokens, and reserve both header separators.
    return 0 < int(words[2]) and int(words[2]) * 2 + sum(len(path.encode()) + 16 for path in paths) <= 8192

'''
needle = '\ntry:\n    data = json.loads'
assert code.count(needle) == 1 and code.count('if count >= 2:') == 1
code = code.replace(needle, '\n' + definition + needle)
code = code.replace('if count >= 2:', 'if count >= 2 and not bounded_head(command):')
hook.write_text(code)

checks = [
    ("head -c 64 a.md b.md", 0),
    ("head -c 5000 a.md b.md", 2),
    ("cat a.md b.md", 2),
    ("head -c 64 '*.md' b.md", 2),
    ("head -c 64 a.md b.md | cat", 2),
    ("head -c 64 a.md b.md; cat c.md", 2),
    ("head -c 64 a.md b.md c.md", 2),
    ("head -c -64 a.md b.md", 2),
]
for command, expected in checks:
    result = subprocess.run(["bash", str(hook)], input=json.dumps({"tool_input": {"command": command}}), text=True, capture_output=True)
    assert result.returncode == expected, (command, result.returncode, result.stderr)
print(json.dumps({"prototype_only": True, "checks": len(checks), "hook": str(hook)}))
