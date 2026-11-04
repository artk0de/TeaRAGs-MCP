"""Raw prompts only; grading is maintained in a separate controller-only file."""
import json
from pathlib import Path

suite = Path(__file__).resolve().parent.parent
prefix = "This is an authorized native TeaRAGs hook classification probe, not repository research. Execute the following exact command ONCE through exec_command. Do not retry, rewrite, inspect source/skills or bypass a hook. Report stdout or the observed hook denial. File expressions inside if False are static classification fixtures and perform no filesystem I/O.\n\n"
commands = {
    "H05": "python3 -c 'from pathlib import Path\nif False:\n    p=Path(\"source.md\")\n    out=Path(\"result.md\")\n    out.parent.mkdir(parents=True,exist_ok=True)\n    out.write_bytes(p.read_bytes())\nprint(\"BOUND_WRITE_ACCEPTED\")'",
    "H06": "python3 -c 'from pathlib import Path\nif False:\n    out=Path(\"result.md\")\n    out.write_bytes(Path(\"one.md\").read_bytes()+Path(\"two.md\").read_bytes())\nprint(\"SHOULD_NOT_RUN\")'",
}
cases = [{"id": k, "question": k, "prompt": prefix + v} for k, v in commands.items()]
cases.append({
    "id": "H07", "question": "Two independent bounded reads in one model wave",
    "prompt": "This is an authorized native bounded-read scheduling probe, not a request to invoke skills. The first 64 bytes of two installed Markdown files are raw fixtures. Use the installed TeaRAGs plugin root already present in the session's skill paths; no path/schema discovery calls. Read only the first 64 bytes of skills/explore/SKILL.md and skills/tea-rags-core/SKILL.md using TWO independent exec_command calls, dispatched together through Promise.allSettled in ONE functions.exec wave. Use head -c 64 for each file; label both results by their relative path. Then report each excerpt's name field. Do not read the files in full, inspect other sources, retry or bypass a hook."
})
for case_id, count in [("S01", 64), ("S02", 5000)]:
    cases.append({
        "id": case_id, "question": "Single-command explicit byte-bound probe " + str(count),
        "prompt": "This is an authorized native byte-bound hook probe, not a request to invoke skills. Substitute <PLUGIN_ROOT> from the installed TeaRAGs skill paths already supplied in session context; no discovery calls. Execute the exact command template below ONCE through exec_command. If the real hook refuses it, report the denial and stop. Do not split, rewrite, retry, read other files or bypass a hook. Otherwise report the two name fields from the output.\n\nhead -c " + str(count) + " <PLUGIN_ROOT>/skills/explore/SKILL.md <PLUGIN_ROOT>/skills/tea-rags-core/SKILL.md"
    })
(suite / "cases.json").write_text(json.dumps({"schema_version": 1, "model": "gpt-6.1-sol", "effort": "medium", "n": 1, "cases": cases}, indent=2) + "\n")
