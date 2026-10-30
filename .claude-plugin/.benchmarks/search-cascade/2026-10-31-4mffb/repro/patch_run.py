from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text()


def rep(old, new, count=1):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, count)


rep('spec = importlib.util.spec_from_file_location("routing_rpc", ROOT / ".tmp/codex61_app_rpc.py")',
    'spec = importlib.util.spec_from_file_location("routing_rpc", BASE / "codex61_app_rpc.py")')
rep('''SOURCES = [
    ("targeted", ROOT / ".claude-plugin/.benchmarks/explore/evals/2026-10-30-targeted-context-reads.json"),
    ("batch", ROOT / ".claude-plugin/.benchmarks/search-cascade/evals/2026-10-30-independent-read-batches.json"),
    ("architecture", ROOT / ".claude-plugin/.benchmarks/architecture-diagnostics/evals/2026-10-30-explicit-activation.json"),
]''', '''SOURCES = [
    ("e", ROOT / ".claude-plugin/.benchmarks/search-cascade/evals/2026-10-31-migration-history-class-contract.json"),
]
RUNS = int(os.environ.get("RUNS", "3"))
ONLY = [x for x in os.environ.get("ONLY", "").split(",") if x]''')
rep('''def prepare():
    run = BASE / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns() % 1000000000))
    run.mkdir(parents=True)
    marketplace = run / "marketplace"
    shipped = ROOT / "harness/codex/tea-rags"''', '''def prepare(arm):
    run = BASE / "runs" / (arm + "-" + time.strftime("%Y%m%d-%H%M%S"))
    run.mkdir(parents=True)
    marketplace = run / "marketplace"
    shipped = BASE / "baseline-codex-tea-rags" if arm == "baseline" else ROOT / "harness/codex/tea-rags"''')
rep('''    catalog = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())''',
    '''    catalog = json.loads(((BASE / "baseline-marketplace.json") if arm == "baseline" else (ROOT / ".agents/plugins/marketplace.json")).read_text())''')
rep('''    assert version == "0.53.8", version
''', '')
rep('''    manifest = {"ROOTGO": False,''', '''    manifest = {"arm": arm, "ROOTGO": False,''')
rep('''        for case in raw.get("evals", raw.get("cases", [])):
            directory = run / "cases" / (suite + "-" + str(case["id"]))
            directory.mkdir(parents=True)
            meta = compile_case(suite, case, directory)''', '''        for case in raw.get("evals", raw.get("cases", [])):
          if ONLY and case["id"] not in ONLY:
            continue
          for attempt in range(1, RUNS + 1):
            directory = run / "cases" / (suite + "-" + str(case["id"]) + "-r" + str(attempt))
            directory.mkdir(parents=True)
            meta = compile_case(suite, case, directory)
            meta["key"] = meta["key"] + "-r" + str(attempt)''')
rep('''    manifest["rootgo_source"] = "Explicit parent instruction authorizing these 13 current-plugin eval cases only"''',
    '''    manifest["rootgo_source"] = "Parent lane instruction (bead 4mffb): Codex x3 per case, baseline and after arms"''')
rep('''        deadline = time.monotonic() + 180''', '''        deadline = time.monotonic() + 420''')
rep('''            raise TimeoutError("180-second actor deadline; no retry")''', '''            raise TimeoutError("420-second actor deadline; no retry")''')
rep('''    subs.add_parser("prepare")''', '''    prep = subs.add_parser("prepare")
    prep.add_argument("arm", choices=["baseline", "current"])''')
rep('''        prepare()''', '''        prepare(args.arm)''')
p.write_text(s)
print("patched")
